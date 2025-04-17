import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, moment, parseYaml, Vault, MetadataCache, TextComponent, ExtraButtonComponent } from 'obsidian';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { google, calendar_v3 } from 'googleapis';
import { GaxiosResponse } from 'gaxios';
import { RRule, RRuleSet, rrulestr, Frequency, Options as RRuleOptions } from 'rrule';
import * as http from 'http';
import { randomBytes } from 'crypto';
import { URL } from 'url';
import * as net from 'net'; // Import net for AddressInfo typing

// --- インターフェース定義 ---

// Obsidian から抽出するタスクデータの構造
interface ObsidianTask {
	id: string; // 一意な識別子 (例: filePath + hash)
	rawText: string; // 元の Markdown 行
	summary: string; // タスクの説明 (絵文字や日付などを除いたもの)
	isCompleted: boolean;
	dueDate: string | null; // 📅 YYYY-MM-DD または ISO 8601
	startDate: string | null; // 🛫 YYYY-MM-DD または ISO 8601
	scheduledDate: string | null; // ⏳ YYYY-MM-DD または ISO 8601 (Now primarily for description)
	createdDate: string | null; // ➕ YYYY-MM-DD
	completionDate: string | null; // ✅ YYYY-MM-DD
	priority: 'highest' | 'high' | 'medium' | 'low' | 'lowest' | null; // 🔺⏫🔼🔽⏬
	recurrenceRule: string | null; // 🔁 rule -> RRULE string (RFC 5545)
	tags: string[];
	blockLink: string | null; // 行末の ^blockid
	sourcePath: string; // ファイルパス
	sourceLine: number; // 行番号 (0-based)
}

// Google Calendar API に渡すイベントデータ
type GoogleCalendarEventInput = calendar_v3.Schema$Event; // スキーマ型を使用

interface GoogleCalendarTasksSyncSettings {
	clientId: string;
	clientSecret: string;
	tokens: Credentials | null;
	calendarId: string;
	syncIntervalMinutes: number;
	autoSync: boolean;
	taskMap: { [obsidianTaskId: string]: string }; // ObsidianタスクID <-> Google CalendarイベントID
	// --- 同期オプション ---
	syncPriorityToDescription: boolean;
	syncTagsToDescription: boolean;
	syncBlockLinkToDescription: boolean;
	syncScheduledDateToDescription: boolean; // New option to add scheduled date to description
	// --- デフォルト設定 ---
	defaultEventDurationMinutes: number;
	// --- Loopback Server Settings ---
	useLoopbackServer: boolean; // Kept for consistency, but now always true effectively
	loopbackPort: number; // This now reflects the *configured* port, may differ from actual running port
}

const DEFAULT_SETTINGS: GoogleCalendarTasksSyncSettings = {
	clientId: '',
	clientSecret: '',
	tokens: null,
	calendarId: 'primary',
	syncIntervalMinutes: 15,
	autoSync: true,
	taskMap: {},
	syncPriorityToDescription: true,
	syncTagsToDescription: true,
	syncBlockLinkToDescription: false,
	syncScheduledDateToDescription: true, // Add scheduled date to description by default
	defaultEventDurationMinutes: 60,
	useLoopbackServer: true, // Force true, local server is now the only method
	loopbackPort: 3000, // Default port
};

export default class GoogleCalendarTasksSyncPlugin extends Plugin {
	settings: GoogleCalendarTasksSyncSettings;
	oauth2Client!: OAuth2Client; // Definite assignment assertion used carefully
	calendar: calendar_v3.Calendar | null = null;
	syncIntervalId: number | null = null;
	httpServer: http.Server | null = null; // HTTPサーバーインスタンス
	private activeOAuthState: string | null = null; // Authentication flow state

	// Get the redirect URI. Now always returns the loopback URI.
	getRedirectUri(): string {
		// Always use the port from settings for the URI displayed/used for auth URL generation.
		const port = this.settings.loopbackPort;
		if (port >= 1024 && port <= 65535) {
			return `http://127.0.0.1:${port}/oauth2callback`;
		} else {
			console.warn(`Invalid loopback port number in settings: ${port}. Using default port ${DEFAULT_SETTINGS.loopbackPort} for URI generation.`);
			// Reflect the default port in the URI if setting is invalid
			return `http://127.0.0.1:${DEFAULT_SETTINGS.loopbackPort}/oauth2callback`;
		}
	}

	async onload() {
		console.log('Loading Google Calendar Sync Plugin');
		await this.loadSettings();
		// Force useLoopbackServer to true if loaded value was false
		if (!this.settings.useLoopbackServer) {
			console.log("Forcing 'useLoopbackServer' to true (only supported method).");
			this.settings.useLoopbackServer = true;
			// No need to save immediately, will be handled by subsequent logic/saves
		}

		// Initialize OAuth2 Client based on loaded settings
		this.reconfigureOAuthClient();

		// Attach token listener and initialize API if tokens exist
		if (this.settings.tokens) {
			try {
				this.oauth2Client.setCredentials(this.settings.tokens);
			} catch (e) {
				console.error("Error setting credentials on load:", e);
				this.settings.tokens = null; // Clear potentially invalid tokens
				await this.saveData(this.settings);
			}
			if(this.settings.tokens) { // Re-check if tokens were cleared
				this.attachTokenListener(); // Attach listener after initial setup
				this.initializeCalendarApi(); // Initialize API client if tokens exist
			}
		}

		// Start Loopback Server (it's always enabled now)
		await this.stopHttpServer(); // Ensure any previous instance is stopped cleanly
		this.startHttpServer(); // Attempt to start server (with auto-port finding)


		// --- Commands ---
		this.addCommand({
			id: 'authenticate-with-google',
			name: 'Authenticate with Google',
			callback: () => this.authenticate(),
		});

		this.addCommand({
			id: 'sync-tasks-now',
			name: 'Sync Tasks with Google Calendar Now',
			callback: async () => {
				// Check for tokens AND validity (or refresh possibility)
				if (!this.settings.tokens || (!this.isTokenValid(false) && !this.isTokenValid(true))) {
					new Notice("Not authenticated or token expired/invalid. Please authenticate/re-authenticate via settings.");
					return;
				}
				new Notice('Manual sync started...');
				await this.syncTasks();
			},
		});

		// --- Obsidian Protocol Handler REMOVED ---

		// --- Settings Tab ---
		this.addSettingTab(new GoogleCalendarSyncSettingTab(this.app, this));
		// --- Auto Sync Setup ---
		this.setupAutoSync();
	}

	async onunload() {
		console.log('Unloading Google Calendar Sync Plugin');
		this.clearAutoSync(); // Clear interval timer
		await this.stopHttpServer(); // Stop server on unload
	}

	// --- HTTP Server Logic (startHttpServer, stopHttpServer, handleHttpRequest are UNCHANGED from previous version with auto-port finding) ---

	/**
	 * Starts the HTTP server for OAuth callback.
	 * Attempts to use the configured port, but automatically tries subsequent ports
	 * if the configured one is busy ('EADDRINUSE'). Updates the settings and notifies
	 * the user if a different port is used.
	 */
	startHttpServer(): void {
		if (this.httpServer) {
			console.log("HTTP server start attempt skipped: Server instance already exists.");
			return;
		}
		// No need to check useLoopbackServer setting anymore, it's assumed true

		const configuredPort = this.settings.loopbackPort;
		// Validate configured port before starting attempts
		if (!(configuredPort >= 1024 && configuredPort <= 65535)) {
			new Notice(`Invalid port number configured (${configuredPort}). Server not started. Please configure a valid port (1024-65535) in settings.`, 10000);
			console.error(`Invalid port number configured (${configuredPort}). Server not started.`);
			return;
		}

		const maxAttempts = 10; // How many ports to try (configured + next 9)
		let currentAttempt = 0;

		const attemptListen = (portToTry: number) => {
			if (currentAttempt >= maxAttempts) {
				const lastTriedPort = configuredPort + maxAttempts - 1;
				console.error(`Failed to start server: Ports ${configuredPort} through ${lastTriedPort} are all in use or other error occurred.`);
				new Notice(`Error: Could not start server. Ports ${configuredPort}-${lastTriedPort} may be busy. Check running applications or choose a different port in settings.`, 15000);
				this.httpServer = null; // Ensure it's null if all attempts failed
				return;
			}
			currentAttempt++;

			// Create a new server instance for each attempt
			const server = http.createServer(this.handleHttpRequest.bind(this));

			// --- Server Event Handlers ---
			server.on('error', (error: NodeJS.ErrnoException) => {
				// Clean up listeners immediately to prevent leaks on retry/failure
				server.removeAllListeners('error');
				server.removeAllListeners('listening');

				if (error.code === 'EADDRINUSE') {
					console.warn(`Port ${portToTry} is in use. Trying next port (${portToTry + 1})...`);
					// Important: Don't assign this.httpServer here.
					// Recursively call attemptListen for the next port.
					attemptListen(portToTry + 1);
				} else {
					// Handle other server errors (e.g., permission denied - EACCES)
					console.error(`HTTP server error on port ${portToTry}:`, error);
					new Notice(`HTTP Server Error (${error.code}): ${error.message}. Server not started. Check console.`, 10000);
					this.httpServer = null; // Ensure null on fatal error
					// Do not retry on errors other than EADDRINUSE
				}
			});

			server.on('listening', async () => { // Make listening callback async for saving data
				 // Clean up error listener once listening succeeds
				server.removeAllListeners('error');

				// Success! Assign the running server instance
				this.httpServer = server;
				// Get the actual port the server bound to
				const successfulPort = (server.address() as net.AddressInfo).port;
				console.log(`HTTP server listening successfully on http://127.0.0.1:${successfulPort}/oauth2callback`);

				// Check if the successful port differs from the configured one
				if (successfulPort !== this.settings.loopbackPort) {
					const oldPort = this.settings.loopbackPort;
					console.warn(`ACTION REQUIRED: Configured port ${oldPort} was busy. Server automatically started on port ${successfulPort}.`);
					const newRedirectUri = `http://127.0.0.1:${successfulPort}/oauth2callback`;

					// Show a persistent and clear Notice MANDATING user action
					const noticeDuration = 30000; // Show for 30 seconds
					new Notice(
						`IMPORTANT: Port ${oldPort} was busy.\n` +
						`Server auto-started on port ${successfulPort}.\n\n` +
						`➡️ You MUST update the Redirect URI in Google Cloud Console to:\n` +
						`${newRedirectUri}\n\n` +
						`Authentication WILL FAIL until you do this.\n` +
						`(Plugin setting updated to ${successfulPort} automatically).`,
						noticeDuration
					);
					console.warn(`IMPORTANT: Update Google Cloud Redirect URI to ${newRedirectUri}`);


					// Update the setting in memory and save *directly*
					this.settings.loopbackPort = successfulPort;
					try {
						await this.saveData(this.settings);
						console.log(`Plugin setting 'loopbackPort' updated from ${oldPort} to ${successfulPort} and saved.`);
						// DO NOT call saveSettings() here - it triggers reconfiguration which might restart the server unnecessarily.
						// The user MUST update Google Console; the plugin itself will use the correct port for auth URL generation *next time* settings are saved or plugin reloads.
						// Refreshing the settings UI is ideal but complex to do reliably from here. The notice is the primary feedback.

					} catch(saveError) {
						console.error("Failed to save the automatically updated port setting:", saveError);
						new Notice(`Error saving auto-selected port (${successfulPort}). Please update the port to ${successfulPort} manually in settings.`, 10000);
						// Server is running, but setting might revert on next Obsidian restart if save failed.
					}
				}
				// Server is running, either on configured or auto-selected port.
			});

			// --- Attempt to listen ---
			try {
				// console.log(`Attempt ${currentAttempt}/${maxAttempts}: Trying to listen on 127.0.0.1:${portToTry}...`);
				server.listen(portToTry, '127.0.0.1'); // Listen only on localhost
			} catch (syncListenError) {
				// Catch synchronous errors during listen() setup, though less common than the async 'error' event
				 console.error(`Synchronous error trying to listen on port ${portToTry}:`, syncListenError);
				 // Ensure listeners are removed if synchronous error occurs before 'listening' or 'error'
				 server.removeAllListeners('error');
				 server.removeAllListeners('listening');
				 // Don't retry here; the 'error' event is the primary mechanism for EADDRINUSE retry
				 if ((syncListenError as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') {
					  new Notice(`Unexpected error starting server: ${syncListenError instanceof Error ? syncListenError.message : String(syncListenError)}. Check console.`, 10000);
					  this.httpServer = null; // Ensure null on failure
					  // Stop retrying if it wasn't EADDRINUSE
					  currentAttempt = maxAttempts; // Prevent further attempts by meeting loop condition
				 } else {
					  // If it *was* EADDRINUSE synchronously (rare), let the 'error' event handle the retry logic if it fires.
					  // If 'error' doesn't fire, the attemptListen recursion might handle it, but rely on 'error'.
				 }
			}
		};

		// Start the first attempt with the configured port
		attemptListen(configuredPort);
	}


	async stopHttpServer(): Promise<void> {
		return new Promise((resolve) => {
			if (this.httpServer && this.httpServer.listening) {
				console.log("Stopping HTTP server...");
				this.httpServer.close((err) => {
					if (err) {
						console.error("Error stopping HTTP server:", err);
					} else {
						console.log("HTTP server stopped successfully.");
					}
					this.httpServer = null; // Clear the instance regardless of error
					resolve();
				});
			} else {
				// console.log("HTTP server already stopped or not running.");
				this.httpServer = null; // Ensure it's null
				resolve(); // Already stopped or not running
			}
		});
	}

	// Handles incoming requests to the local HTTP server
	private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!req.url || !this.httpServer) { // Added check for httpServer existence
			res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Bad Request: No URL specified or server not ready');
			return;
		}

		// Determine the correct host and port the *server* is actually listening on
		const serverAddress = this.httpServer.address();
		const host = serverAddress && typeof serverAddress === 'object' ? `127.0.0.1:${serverAddress.port}` : `127.0.0.1:${this.settings.loopbackPort}`; // Fallback just in case

		let currentUrl: URL;
		try {
			 // Ensure proper URL construction
			 const fullUrl = req.url.startsWith('/') ? `http://${host}${req.url}` : req.url;
			 currentUrl = new URL(fullUrl);
		} catch (e) {
			console.error("Error parsing request URL:", req.url, e);
			res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Bad Request: Invalid URL format');
			return;
		}

		// --- Handle OAuth Callback Path ---
		if (currentUrl.pathname === '/oauth2callback' && req.method === 'GET') {
			console.log('OAuth callback request received by HTTP server');
			const queryParams = currentUrl.searchParams;
			const params: Record<string, string> = {};
			queryParams.forEach((value, key) => {
				params[key] = value;
			});

			try {
				await this.handleOAuthCallback(params);
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`
					<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Authentication Success</title><style>body{font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; padding: 30px; text-align: center; background-color: #f0f9f0; color: #333;} h1{color: #28a745;} p{font-size: 1.1em;}</style></head>
					<body><h1>✅ Authentication Successful!</h1><p>Google Calendar Sync is now connected.</p><p>You can close this window and return to Obsidian.</p><script>setTimeout(() => window.close(), 3000);</script></body></html>`);
			} catch (error: any) {
				console.error("Error handling OAuth callback via HTTP:", error);
				res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(`
					 <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Authentication Failed</title><style>body{font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; padding: 30px; color:#333; background-color: #fff8f8;} h1{color: #dc3545;} p{font-size: 1.1em;} .error {color: #c00; font-weight: bold; white-space: pre-wrap; word-break: break-all; text-align: left; background: #eee; padding: 10px; border-radius: 5px;}</style></head>
					<body><h1>❌ Authentication Failed</h1><p>Could not complete Google authentication.</p><p>Error details:</p><pre class="error">${error.message || 'Unknown error'}.</pre><p>Please check the Obsidian Developer Console (Ctrl+Shift+I or Cmd+Opt+I) for more details, verify your Client ID/Secret and Redirect URI settings (especially the port number if it was changed automatically), and try authenticating again from the plugin settings.</p></body></html>`);
			}
		// --- Handle Favicon Request (common browser request) ---
		} else if (currentUrl.pathname === '/favicon.ico' && req.method === 'GET') {
			 res.writeHead(204);
			 res.end();
		// --- Handle Root Path (optional check) ---
		} else if (currentUrl.pathname === '/' && req.method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Obsidian Google Calendar Sync Plugin - Local server active for OAuth.');
		} else {
			console.log(`Received request for unknown path: ${currentUrl.pathname}`);
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('404 Not Found');
		}
	}


	// --- Centralized OAuth Callback Handler (UNCHANGED) ---
	private async handleOAuthCallback(params: Record<string, string>): Promise<void> {
		const { code, error, state } = params;
		const currentActiveState = this.activeOAuthState; // Store locally before potential clearing

		// 1. Verify State Parameter (CSRF Protection)
		if (!currentActiveState) {
			console.warn("No active OAuth state found. Ignoring callback, possibly duplicate or unexpected.");
			throw new Error('No active authentication attempt found. Please initiate authentication from Obsidian settings again.');
		}
		if (!state || state !== currentActiveState) {
			this.activeOAuthState = null; // Clear invalid state immediately
			console.error('OAuth Error: Invalid state parameter received.', 'Received:', state, 'Expected:', currentActiveState);
			new Notice('Authentication failed: Security token mismatch (invalid state). Please try authenticating again.', 10000);
			throw new Error('Invalid state parameter. Authentication flow may be compromised or timed out.');
		}
		console.log("OAuth state verified successfully.");
		this.activeOAuthState = null; // Clear *valid* state after successful verification

		// 2. Check for Errors from Google
		if (error) {
			console.error('OAuth Error reported by Google:', error);
			const errorDescription = params.error_description ? decodeURIComponent(params.error_description) : 'No additional description provided.';
			const errorUri = params.error_uri ? decodeURIComponent(params.error_uri) : null;
			let errMsg = `Google authentication failed: ${error}. ${errorDescription}`;
			if (errorUri) errMsg += ` More info: ${errorUri}`;
			new Notice(errMsg, 15000); // Longer notice for errors
			throw new Error(errMsg); // Use error description in thrown error
		}

		// 3. Ensure Authorization Code Exists
		if (!code) {
			console.error('OAuth Error: No authorization code received from Google.');
			new Notice('Google authentication failed: No authorization code received.');
			throw new Error('Authorization code missing in callback from Google.');
		}

		// 4. Exchange Code for Tokens
		try {
			new Notice('Exchanging authorization code for Google tokens...', 4000);
			// Create a temporary client instance using the current settings
			// The redirect URI used here MUST match the one used to generate the auth URL.
			const redirectUriForExchange = this.getRedirectUri(); // Use the URI based on current SETTINGS
			const tokenExchangeClient = new OAuth2Client({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
				redirectUri: redirectUriForExchange,
			});

			console.log(`Attempting token exchange with code using redirect_uri: ${redirectUriForExchange}`);
			const { tokens } = await tokenExchangeClient.getToken(code);
			console.log('Tokens received successfully.');

			const currentRefreshToken = this.settings.tokens?.refresh_token;
			const newRefreshToken = tokens.refresh_token;

			if (!newRefreshToken && !currentRefreshToken) {
				console.warn("OAuth Warning: No refresh token received and none existed previously. Offline access might require re-authentication later.");
				new Notice("Authentication successful, but no refresh token was granted by Google. You may need to re-authenticate periodically if offline access is needed.", 10000);
			} else if (newRefreshToken && newRefreshToken !== currentRefreshToken) {
				 console.log("Received a new refresh token from Google.");
			} else if (!newRefreshToken && currentRefreshToken) {
				 console.log("No new refresh token received, keeping the existing one.");
			}

			// Merge new tokens with existing ones (prioritize new refresh token)
			const finalTokens: Credentials = {
				...this.settings.tokens, // Preserve any existing fields
				...tokens, // Overwrite with new access_token, expiry_date, scope, etc.
				refresh_token: newRefreshToken || currentRefreshToken // Use new refresh token if available
			};

			// Update the main plugin's OAuth client and settings
			this.oauth2Client.setCredentials(finalTokens); // Update the main client
			this.settings.tokens = finalTokens;

			// Use saveData directly to avoid saveSettings side effects
			await this.saveData(this.settings);

			// Manually re-initialize dependent components
			this.initializeCalendarApi(); // Ensure API client uses the new token
			this.setupAutoSync(); // Reset timer with potentially new token info
			this.attachTokenListener(); // Ensure listener is attached to the main client

			new Notice('Google Authentication Successful!', 6000);

		} catch (err: any) {
			console.error('OAuth token exchange failed:', err);
			let errorMessage = 'Google authentication failed during token exchange.';
			const responseData = err?.response?.data;
			if (responseData?.error) {
				 errorMessage += ` Details: ${responseData.error}`;
				 if (responseData.error_description) {
					 errorMessage += ` - ${responseData.error_description}`;
				 }
				 // Provide hints for common errors
				 if (responseData.error === 'invalid_grant') {
					errorMessage += " (Possible causes: auth code expired/used, clock skew, incorrect Redirect URI used for *token request*).";
				 } else if (responseData.error === 'redirect_uri_mismatch') {
					 // This error during token exchange usually means the URI in the request differs from the one pre-registered for the client ID in Google Console.
					 errorMessage += ` (The Redirect URI sent during token exchange [${this.getRedirectUri()}] might not EXACTLY match one registered in Google Cloud Console).`;
				 } else if (responseData.error === 'invalid_client') {
					  errorMessage += " (Check Client ID and/or Client Secret in settings).";
				 }
			} else if (err.message) {
				errorMessage += ` Error: ${err.message}`;
			}
			new Notice(errorMessage + ' Check Obsidian console for details.', 15000);
			throw new Error(errorMessage); // Re-throw with detailed message
		}
	}

	async loadSettings() { // UNCHANGED
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Ensure taskMap exists
		if (!this.settings.taskMap || typeof this.settings.taskMap !== 'object') {
			this.settings.taskMap = {};
		}
		// Force loopback server setting on load for correctness with removed option
		 this.settings.useLoopbackServer = true;
		// Validate loopback port on load
		if (typeof this.settings.loopbackPort !== 'number' || !Number.isInteger(this.settings.loopbackPort) || this.settings.loopbackPort < 1024 || this.settings.loopbackPort > 65535) {
			console.warn(`Loaded invalid loopback port "${this.settings.loopbackPort}". Resetting to default ${DEFAULT_SETTINGS.loopbackPort}.`);
			this.settings.loopbackPort = DEFAULT_SETTINGS.loopbackPort;
		}
		// Validate duration on load
		 if (typeof this.settings.defaultEventDurationMinutes !== 'number' || !Number.isInteger(this.settings.defaultEventDurationMinutes) || this.settings.defaultEventDurationMinutes < 5) {
			 console.warn(`Loaded invalid default duration "${this.settings.defaultEventDurationMinutes}". Resetting to default ${DEFAULT_SETTINGS.defaultEventDurationMinutes}.`);
			 this.settings.defaultEventDurationMinutes = DEFAULT_SETTINGS.defaultEventDurationMinutes;
		 }
		// Validate interval on load
		 if (typeof this.settings.syncIntervalMinutes !== 'number' || !Number.isInteger(this.settings.syncIntervalMinutes) || this.settings.syncIntervalMinutes < 1) {
			 console.warn(`Loaded invalid sync interval "${this.settings.syncIntervalMinutes}". Resetting to default ${DEFAULT_SETTINGS.syncIntervalMinutes}.`);
			 this.settings.syncIntervalMinutes = DEFAULT_SETTINGS.syncIntervalMinutes;
		 }
	}

	async saveSettings() { // UNCHANGED
		await this.saveData(this.settings);
		console.log("Settings saved, triggering reconfiguration...");
		// Perform reconfiguration needed after settings change
		await this.reconfigureAfterSettingsChange();
	}

	// Helper function to manage reconfiguration after settings change (Simplified as server is always 'on')
	async reconfigureAfterSettingsChange() {
		console.log("Reconfiguring plugin components after settings change...");
		const serverIsRunning = !!this.httpServer && this.httpServer.listening;
		const currentServerPort = serverIsRunning ? (this.httpServer?.address() as net.AddressInfo)?.port : null;

		// 1. Reconfigure OAuth Client
		this.reconfigureOAuthClient();

		// 2. Initialize Google Calendar API client
		this.initializeCalendarApi();

		// 3. Reset/Setup auto-sync timer
		this.setupAutoSync();

		// 4. Manage HTTP Server State
		// Server should always be running now. Check if it needs restarting due to port config change.
		const configuredPort = this.settings.loopbackPort;
		const needsStarting = !serverIsRunning;
		const needsRestartForConfig = serverIsRunning && currentServerPort !== configuredPort;

		if (needsStarting || needsRestartForConfig) {
			 console.log(`HTTP server needs ${needsStarting ? 'starting' : `restarting (port configured: ${configuredPort}, running: ${currentServerPort})`}.`);
			 await this.stopHttpServer();
			 this.startHttpServer(); // Start/Restart (will use configured port, may auto-find again)
		} else {
			 // console.log(`HTTP server state unchanged (Running: ${serverIsRunning}, Port: ${currentServerPort}, Configured: ${configuredPort}).`);
		}
		console.log("Reconfiguration complete.");
	}


	// Reconfigures the main OAuth2 client instance (UNCHANGED)
	reconfigureOAuthClient() {
		const redirectUri = this.getRedirectUri(); // Get redirect URI based on CURRENT settings
		try {
			this.oauth2Client = new OAuth2Client({
				clientId: this.settings.clientId,
				clientSecret: this.settings.clientSecret,
				redirectUri: redirectUri,
			});
		} catch(e) {
			 console.error("Error creating OAuth2Client instance:", e);
			 // @ts-ignore // Assign null if creation fails
			 this.oauth2Client = null;
			 return; // Cannot proceed
		}
		if (this.settings.tokens) {
			try { this.oauth2Client.setCredentials(this.settings.tokens); }
			catch (e) { console.error("Error applying credentials during OAuth client reconfiguration:", e); }
		}
		this.attachTokenListener();
	}

	// Attaches the token listener (UNCHANGED)
	attachTokenListener() {
		if (!this.oauth2Client) { console.warn("Cannot attach token listener: OAuth client not initialized."); return; }
		this.oauth2Client.removeAllListeners('tokens');
		this.oauth2Client.on('tokens', async (tokens) => {
			console.log("OAuth client emitted 'tokens' event (likely token refresh).");
			const currentRefreshToken = this.settings.tokens?.refresh_token;
			const newRefreshToken = tokens.refresh_token;
			const updatedTokens: Credentials = { ...this.settings.tokens, ...tokens, refresh_token: newRefreshToken || currentRefreshToken };
			if (newRefreshToken && newRefreshToken !== currentRefreshToken) console.log("Received a new refresh token.");
			this.settings.tokens = updatedTokens;
			try {
				 await this.saveData(this.settings);
				 console.log("Updated tokens saved successfully.");
				 this.initializeCalendarApi();
			} catch (saveError) {
				 console.error("Failed to save updated tokens:", saveError);
				 new Notice("Error saving refreshed Google tokens. Check console.", 5000);
			}
		});
	}

	// Initializes the Google Calendar API service (UNCHANGED)
	initializeCalendarApi() {
		if (!this.oauth2Client) {
			console.warn("Cannot initialize Calendar API: OAuth client is not configured.");
			if (this.calendar) this.calendar = null; return;
		}
		if (this.settings.tokens && this.oauth2Client.credentials?.access_token) {
			if (!this.calendar || (this.calendar as any)._options?.auth !== this.oauth2Client) {
				 try {
					this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
					console.log('Google Calendar API client initialized or updated.');
				 } catch(e) { console.error("Failed to initialize Google Calendar API client:", e); this.calendar = null; }
			}
		} else {
			if (this.calendar) { console.log('De-initializing Google Calendar API client (missing tokens or invalid client).'); this.calendar = null; }
		}
	}

	// Initiates the Google OAuth authentication flow (UNCHANGED)
	authenticate() {
		if (!this.settings.clientId || !this.settings.clientSecret) { new Notice('Authentication failed: Client ID and Client Secret must be set.', 7000); return; }
		this.reconfigureOAuthClient(); // Ensure client uses latest settings
		if (!this.oauth2Client) { new Notice('Authentication failed: Could not configure OAuth client. Check console.', 7000); return; }
		const currentRedirectUri = this.getRedirectUri();
		if (!currentRedirectUri || !currentRedirectUri.startsWith('http')) { new Notice('Authentication failed: Invalid Redirect URI. Check port setting.', 10000); console.error("Invalid Redirect URI:", currentRedirectUri); return; }
		new Notice(`Please ensure this Redirect URI is added in Google Cloud Console:\n${currentRedirectUri}`, 15000);
		try {
			this.activeOAuthState = randomBytes(16).toString('hex');
			console.log("Generated OAuth state:", this.activeOAuthState);
			const authUrl = this.oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar.events'], prompt: 'consent', state: this.activeOAuthState, redirect_uri: currentRedirectUri });
			console.log('Opening Google authorization URL...'); window.open(authUrl);
			new Notice('Please authorize this plugin in the browser window that opened.', 7000);
		} catch (error) {
			this.activeOAuthState = null; console.error("Error generating Google authentication URL:", error);
			new Notice(`Failed to start authentication: ${error instanceof Error ? error.message : 'Unknown error'}. See console.`, 10000);
		}
	}

	// Checks token validity (UNCHANGED)
	isTokenValid(checkRefresh: boolean = false): boolean {
		const tokens = this.settings.tokens; if (!tokens) return false;
		if (checkRefresh) { return !!tokens.refresh_token; }
		else { if (!tokens.access_token) return false; if (tokens.expiry_date) { return tokens.expiry_date > Date.now() + (5 * 60 * 1000); } return true; }
	}

	// Sets up auto sync (UNCHANGED)
	setupAutoSync() {
		this.clearAutoSync();
		if (this.settings.autoSync && this.settings.syncIntervalMinutes >= 1) {
			const intervalMillis = this.settings.syncIntervalMinutes * 60 * 1000;
			console.log(`Setting up auto-sync every ${this.settings.syncIntervalMinutes} minutes.`);
			this.syncIntervalId = window.setInterval(async () => {
				const timestamp = moment().format('HH:mm:ss'); console.log(`[${timestamp}] Auto-sync triggered.`);
				if (!this.settings.tokens || !this.oauth2Client?.credentials?.access_token) { console.warn(`[${timestamp}] Auto-sync: Skipping, not authenticated.`); return; }
				if (!this.isTokenValid(false)) {
					console.log(`[${timestamp}] Auto-sync: Access token expired or missing.`);
					if (this.isTokenValid(true)) {
						console.log(`[${timestamp}] Auto-sync: Attempting token refresh...`);
						try {
							this.reconfigureOAuthClient(); if (!this.oauth2Client) throw new Error("OAuth client unavailable for refresh.");
							await this.oauth2Client.refreshAccessToken();
							if (this.isTokenValid(false)) { console.log(`[${timestamp}] Auto-sync: Token refresh successful.`); new Notice('Google token refreshed automatically.', 4000); }
							else { console.error(`[${timestamp}] Auto-sync: Token refresh okay but token still invalid.`); new Notice('Auto-sync: Token refresh issue. Check console.', 5000); return; }
						} catch (error: any) {
							console.error(`[${timestamp}] Auto-sync: Token refresh failed:`, error); const respErr = error?.response?.data?.error;
							if (respErr === 'invalid_grant') {
								 new Notice('Auto-sync failed: Refresh token invalid. Please re-authenticate.', 15000); this.settings.tokens = null; await this.saveData(this.settings); this.clearAutoSync(); this.initializeCalendarApi();
							} else { new Notice(`Auto-sync: Failed to refresh token (${respErr || 'Unknown'}). Check connection or re-authenticate.`, 10000); }
							return; // Skip sync on refresh failure
						}
					} else {
						 console.warn(`[${timestamp}] Auto-sync: Token expired, no refresh token available.`); new Notice('Auto-sync skipped: Token expired. Re-authenticate.', 10000); this.clearAutoSync(); this.initializeCalendarApi(); return;
					}
				}
				console.log(`[${timestamp}] Auto-sync: Executing task synchronization...`); await this.syncTasks(); console.log(`[${timestamp}] Auto-sync: Synchronization finished.`);
			}, intervalMillis);
			console.log(`Auto-sync timer started (ID: ${this.syncIntervalId}). Next run approx ${moment().add(intervalMillis, 'ms').format('HH:mm')}.`);
		} else { console.log(`Auto-sync disabled (Enabled: ${this.settings.autoSync}, Interval: ${this.settings.syncIntervalMinutes} min).`); }
	}

	// Clears auto sync timer (UNCHANGED)
	clearAutoSync() { if (this.syncIntervalId !== null) { window.clearInterval(this.syncIntervalId); this.syncIntervalId = null; } }

	// --- Task Parsing Logic (UNCHANGED) ---
	parseObsidianTask(line: string, filePath: string, lineNumber: number): ObsidianTask | null {
		const taskRegex = /^\s*-\s*\[(.)\]\s*(.*)/; const match = line.match(taskRegex); if (!match) return null;
		const checkbox = match[1].trim(); let taskContent = match[2].trim(); const isCompleted = checkbox !== ' ' && checkbox !== '';
		const isoOrSimpleDateRegex = `\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?)?`; const simpleDateRegexOnly = `\\d{4}-\\d{2}-\\d{2}`;
		const dueDateMatch = taskContent.match(new RegExp(`(?:📅|due:)\\s*(${isoOrSimpleDateRegex})`)); const startDateMatch = taskContent.match(new RegExp(`(?:🛫|start:)\\s*(${isoOrSimpleDateRegex})`));
		const scheduledDateMatch = taskContent.match(new RegExp(`(?:⏳|scheduled:)\\s*(${isoOrSimpleDateRegex})`)); const createdDateMatch = taskContent.match(new RegExp(`(?:➕|created:)\\s*(${simpleDateRegexOnly})`));
		const completionDateMatch = taskContent.match(new RegExp(`(?:✅|done:)\\s*(${simpleDateRegexOnly})`)); const priorityMatch = taskContent.match(/(?:🔺|⏫|🔼|🔽|⏬)/);
		const priorityEmoji = priorityMatch ? priorityMatch[0] : null; const recurrenceMatch = taskContent.match(/(?:🔁|repeat:|recur:)\s*([^📅🛫⏳➕✅🔺⏫🔼🔽⏬#^]+)/);
		const tagsMatch = taskContent.match(/#[^\s#]+/g); const blockLinkMatch = taskContent.match(/\s+(\^[a-zA-Z0-9-]+)$/);
		const dueDate = dueDateMatch ? dueDateMatch[1] : null; const startDate = startDateMatch ? startDateMatch[1] : null; const scheduledDate = scheduledDateMatch ? scheduledDateMatch[1] : null;
		const createdDate = createdDateMatch ? createdDateMatch[1] : null; const completionDate = completionDateMatch ? completionDateMatch[1] : null;
		let priority: ObsidianTask['priority'] = null; if (priorityEmoji) { switch (priorityEmoji) { case '🔺': priority = 'highest'; break; case '⏫': priority = 'high'; break; case '🔼': priority = 'medium'; break; case '🔽': priority = 'low'; break; case '⏬': priority = 'lowest'; break; } }
		const recurrenceRuleText = recurrenceMatch ? recurrenceMatch[1].trim() : null; const recurrenceRefDate = startDate || dueDate || scheduledDate; // Use start date preference for recurrence base
		const recurrenceRule = recurrenceRuleText ? this.parseRecurrenceRule(recurrenceRuleText, recurrenceRefDate) : null;
		const tags = tagsMatch ? tagsMatch.map(t => t.substring(1)) : []; const blockLink = blockLinkMatch ? blockLinkMatch[1] : null;
		let summary = taskContent; const patternsToRemove = [/(?:📅|due:)\s*/, /(?:🛫|start:)\s*/, /(?:⏳|scheduled:)\s*/, /(?:➕|created:)\s*/, /(?:✅|done:)\s*/, /(?:🔁|repeat:|recur:)\s*/, /[🔺⏫🔼🔽⏬]\s*/, ];
		[dueDate, startDate, scheduledDate, createdDate, completionDate, recurrenceRuleText, blockLink].forEach(val => { if (val) summary = summary.replace(val, ''); });
		patternsToRemove.forEach(pattern => summary = summary.replace(pattern, '')); if (tagsMatch) tagsMatch.forEach(tag => summary = summary.replace(tag, ''));
		summary = summary.replace(/\s{2,}/g, ' ').trim();
		const rawTextForHash = line.trim(); let hash = 0; for (let i = 0; i < rawTextForHash.length; i++) { const char = rawTextForHash.charCodeAt(i); hash = ((hash << 5) - hash) + char; hash |= 0; }
		const taskId = `obsidian-${filePath}-${lineNumber}-${hash}`;
		return { id: taskId, rawText: line, summary: summary || "Untitled Task", isCompleted: isCompleted, dueDate: dueDate, startDate: startDate, scheduledDate: scheduledDate, createdDate: createdDate, completionDate: completionDate, priority: priority, recurrenceRule: recurrenceRule, tags: tags, blockLink: blockLink, sourcePath: filePath, sourceLine: lineNumber };
	}

	// Parses recurrence rule (UNCHANGED)
	parseRecurrenceRule(ruleText: string, dtstartHint: string | null): string | null {
		ruleText = ruleText.toLowerCase().trim(); let finalRruleString: string | null = null;
		if (ruleText.toUpperCase().startsWith('RRULE:') || ruleText.toUpperCase().startsWith('FREQ=')) {
			 try {
				const ruleInput = ruleText.toUpperCase().startsWith('RRULE:') ? ruleText : `RRULE:${ruleText}`;
				const rule = rrulestr(ruleInput, { forceset: true });
				if (!rule.options.dtstart && dtstartHint) { const pDate = moment.utc(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true); if(pDate.isValid()) { rule.options.dtstart = pDate.toDate();} else { console.warn(`Invalid dtstartHint "${dtstartHint}"`); rule.options.dtstart = moment().startOf('day').toDate(); }} else if (!rule.options.dtstart) { rule.options.dtstart = moment().startOf('day').toDate(); console.warn(`RRULE "${ruleText}" missing DTSTART, using today.`); }
				finalRruleString = rule.toString();
			 } catch (e) { console.warn(`Direct RRULE parse failed: "${ruleText}"`, e); }
			 if (finalRruleString) return finalRruleString;
		}
		let dtstartDate: Date; if (dtstartHint) { const pDate = moment.utc(dtstartHint, [moment.ISO_8601, 'YYYY-MM-DD'], true); dtstartDate = pDate.isValid() ? pDate.toDate() : moment().startOf('day').toDate(); } else { dtstartDate = moment().startOf('day').toDate(); }
		let options: Partial<RRuleOptions> = { dtstart: dtstartDate }; let freq: Frequency | null = null; let interval = 1;
		const intMatch = ruleText.match(/every\s+(\d+)\s+(day|week|month|year)s?/); if (intMatch) { interval = parseInt(intMatch[1], 10); const unit = intMatch[2]; if (unit === 'day') freq = Frequency.DAILY; else if (unit === 'week') freq = Frequency.WEEKLY; else if (unit === 'month') freq = Frequency.MONTHLY; else if (unit === 'year') freq = Frequency.YEARLY; }
		else { const simpleIntMatch = ruleText.match(/every\s+(day|week|month|year)s?/); if(simpleIntMatch) { interval = 1; const unit = simpleIntMatch[1]; if (unit === 'day') freq = Frequency.DAILY; else if (unit === 'week') freq = Frequency.WEEKLY; else if (unit === 'month') freq = Frequency.MONTHLY; else if (unit === 'year') freq = Frequency.YEARLY; } else { if (ruleText.includes('daily')) freq = Frequency.DAILY; else if (ruleText.includes('weekly')) freq = Frequency.WEEKLY; else if (ruleText.includes('monthly')) freq = Frequency.MONTHLY; else if (ruleText.includes('yearly') || ruleText.includes('annually')) freq = Frequency.YEARLY; const altIntMatch = ruleText.match(/every\s*(\d+)\s*weeks?/); if (altIntMatch && freq === Frequency.WEEKLY) interval = parseInt(altIntMatch[1], 10); } }
		if (freq === Frequency.MONTHLY) { const dMatch = ruleText.match(/on the\s+(\d+)(?:st|nd|rd|th)?/); if (dMatch) { const day = parseInt(dMatch[1], 10); if (day >= 1 && day <= 31) options.bymonthday = [day]; } }
		if (freq === Frequency.WEEKLY) { const wdMap: { [k: string]: any } = { mon: RRule.MO, tue: RRule.TU, wed: RRule.WE, thu: RRule.TH, fri: RRule.FR, sat: RRule.SA, sun: RRule.SU }; const wds: any[] = []; if (ruleText.includes('weekday')) wds.push(RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR); else if (ruleText.includes('weekend')) wds.push(RRule.SA, RRule.SU); else { ruleText.split(/[\s,]+/).forEach(p => { const dMatch = p.match(/^(mon|tue|wed|thu|fri|sat|sun)/); if (dMatch && wdMap[dMatch[1]]) { const rDay = wdMap[dMatch[1]]; if (!wds.some(ex => ex.weekday === rDay.weekday)) wds.push(rDay); } }); } if (wds.length > 0) options.byweekday = wds; }
		if (freq !== null) { options.freq = freq; options.interval = interval > 0 ? interval : 1; try { const rule = new RRule(options as RRuleOptions); finalRruleString = rule.toString(); } catch (e) { console.warn(`Could not generate RRULE from options:`, options, e); finalRruleString = null; } } else { console.warn(`Could not determine frequency: "${ruleText}"`); finalRruleString = null; }
		return finalRruleString;
	}


	// Fetches all Obsidian tasks (UNCHANGED)
	async getObsidianTasks(): Promise<ObsidianTask[]> {
		const tasks: ObsidianTask[] = []; const mdFiles = this.app.vault.getMarkdownFiles();
		for (const file of mdFiles) { if (file.path.toLowerCase().includes('templates/')) continue; try { const content = await this.app.vault.cachedRead(file); const lines = content.split('\n'); lines.forEach((line, index) => { const task = this.parseObsidianTask(line, file.path, index); if (task) tasks.push(task); }); } catch (e) { console.warn(`Could not read/parse file "${file.path}"`, e); } }
		console.log(`Found ${tasks.length} tasks in vault.`); return tasks;
	}

	// Maps an Obsidian task to a Google Calendar event object using Start/Due dates (UNCHANGED LOGIC, called only for filtered tasks)
	mapObsidianTaskToGoogleEvent(task: ObsidianTask): GoogleCalendarEventInput {
		const event: GoogleCalendarEventInput = {
			summary: task.summary || 'Untitled Task',
			extendedProperties: { private: { obsidianTaskId: task.id, isGcalSync: 'true' } },
			description: this.buildEventDescription(task),
			status: task.isCompleted ? 'cancelled' : 'confirmed',
			// `start`, `end`, and `recurrence` are set below
		};

		// Set event time based on Start Date (🛫) and Due Date (📅)
		// This function is now called only when both startDate and dueDate exist
		this.setEventTimeUsingStartDue(event, task);

		// Set recurrence rule if present AND the event has a start time
		if (task.recurrenceRule && event.start) {
			// Attempt to parse and use the rule; handle potential RRULE: prefix
            let rruleString = task.recurrenceRule.toUpperCase();
            if (!rruleString.startsWith('RRULE:')) {
                rruleString = `RRULE:${rruleString}`;
            }
            // Basic validation (optional but recommended)
            try {
                rrulestr(rruleString); // Check if parsable
                event.recurrence = [rruleString];
            } catch (e) {
                 console.warn(`Invalid RRULE string for task "${task.summary}": ${task.recurrenceRule}. Skipping recurrence.`, e);
                 delete event.recurrence;
            }
		} else {
			delete event.recurrence;
		}

		return event;
	}

	// Builds the description string, adding scheduled date if enabled (UNCHANGED)
	private buildEventDescription(task: ObsidianTask): string {
		let descParts: string[] = [];
		try { // Add Obsidian link
			const vaultName = this.app.vault.getName(); const encodedVault = encodeURIComponent(vaultName); const encodedPath = encodeURIComponent(task.sourcePath);
			descParts.push(`Obsidian Note: obsidian://open?vault=${encodedVault}&file=${encodedPath}`);
		} catch (e) { console.warn("Could not generate Obsidian URI", e); descParts.push(`Obsidian Source: "${task.sourcePath}" (Line ${task.sourceLine + 1})`); }

		let metaParts: string[] = [];
		if (this.settings.syncPriorityToDescription && task.priority) {
			const priorityMap = { highest: '🔺 Highest', high: '⏫ High', medium: '🔼 Medium', low: '🔽 Low', lowest: '⏬ Lowest' };
			metaParts.push(`Priority: ${priorityMap[task.priority] || task.priority}`);
		}
		if (this.settings.syncTagsToDescription && task.tags.length > 0) { metaParts.push(`Tags: ${task.tags.map(t => `#${t}`).join(' ')}`); }
		if (task.createdDate) { metaParts.push(`Created: ${task.createdDate}`); }
		// Add scheduled date if enabled and present
		if (this.settings.syncScheduledDateToDescription && task.scheduledDate) { metaParts.push(`Scheduled: ${task.scheduledDate}`); }
		if (task.completionDate && task.isCompleted) { metaParts.push(`Completed: ${task.completionDate}`); }

		if (metaParts.length > 0) { descParts.push('---'); descParts.push(...metaParts); }
		if (this.settings.syncBlockLinkToDescription && task.blockLink) { descParts.push(`Obsidian Block Link: [[${task.sourcePath}#${task.blockLink}]]`); }

		return descParts.join('\n');
	}

	 // Sets the start and end time/date based on Start Date (start) and Due Date (end) (UNCHANGED LOGIC, called only for filtered tasks)
	 private setEventTimeUsingStartDue(event: GoogleCalendarEventInput, task: ObsidianTask): void {
		const startStr = task.startDate;
		const dueStr = task.dueDate;

		// Assume startStr and dueStr are non-null because syncTasks filters them
        if (!startStr || !dueStr) {
            console.error(`Task "${task.summary}" reached setEventTimeUsingStartDue without both start and due dates. This should not happen. Defaulting time.`);
            this.setDefaultEventTime(event);
            event.description = (event.description || '') + `\n\n(Note: Event time defaulted - Internal error, missing dates)`;
            return;
        }

		const startIsDateTime = startStr.includes('T');
		const dueIsDateTime = dueStr.includes('T');

		let startMoment: moment.Moment | null = null;
		let dueMoment: moment.Moment | null = null;

		// Parse dates (already validated as non-null strings)
		startMoment = moment.utc(startStr, [moment.ISO_8601, 'YYYY-MM-DD'], true);
		if (!startMoment.isValid()) startMoment = null; // Should not happen if parsing is correct, but keep for safety

		dueMoment = moment.utc(dueStr, [moment.ISO_8601, 'YYYY-MM-DD'], true);
		if (!dueMoment.isValid()) dueMoment = null; // Should not happen

		// --- Determine Event Timing ---

		if (startMoment && dueMoment) {
			// Case 1: Both Start and Due Date present (This is the only expected case now)
			// If either is just a date (no time), make the whole event all-day
			if (!startIsDateTime || !dueIsDateTime) {
				// All-day event spanning potentially multiple days
				event.start = { date: startMoment.format('YYYY-MM-DD') };
				// End date is exclusive, so add 1 day to the due date
				event.end = { date: dueMoment.add(1, 'day').format('YYYY-MM-DD') };
                 // Ensure end date is strictly after start date for all-day
                 if (moment(event.end.date).isSameOrBefore(moment(event.start.date))) {
                     console.warn(`Task "${task.summary}": All-day due date (${dueMoment.subtract(1, 'day').format('YYYY-MM-DD')}) is not after start date (${startMoment.format('YYYY-MM-DD')}). Setting end date to start date + 1 day.`);
                     event.end = { date: startMoment.clone().add(1, 'day').format('YYYY-MM-DD') };
                 }
			} else {
				// Both have specific times
				event.start = { dateTime: startMoment.toISOString(true) };
				event.end = { dateTime: dueMoment.toISOString(true) };
				 // Ensure end is after start
				 if (dueMoment.isSameOrBefore(startMoment)) {
					console.warn(`Task "${task.summary}": Due time (${dueMoment.toISOString()}) is not after start time (${startMoment.toISOString()}). Adjusting end time to start + default duration.`);
					event.end = { dateTime: startMoment.clone().add(this.settings.defaultEventDurationMinutes, 'minutes').toISOString(true) };
				 }
			}
		} else {
			// Should not be reached due to the filter in syncTasks
			console.error(`Task "${task.summary}" failed date parsing within setEventTimeUsingStartDue after filtering. Defaulting time.`);
			this.setDefaultEventTime(event);
            event.description = (event.description || '') + `\n\n(Note: Event time defaulted - Internal error, date parsing failed)`;
		}

		// Final check: Ensure start/end are properly defined if we reached here with dates
		if ((event.start?.date && !event.end?.date) || (event.start?.dateTime && !event.end?.dateTime)) {
			 console.error(`Task "${task.summary}" resulted in inconsistent start/end times. Falling back to default.`, event);
			 this.setDefaultEventTime(event);
			 event.description = (event.description || '') + `\n\n(Note: Event time defaulted - Error processing dates)`;
		}
	}


	// Sets a default time for the event (e.g., today all-day) (UNCHANGED)
	private setDefaultEventTime(event: GoogleCalendarEventInput): void {
		const today = moment.utc().format('YYYY-MM-DD'); // Use UTC date for default all-day
		event.start = { date: today };
		event.end = { date: moment.utc(today).add(1, 'day').format('YYYY-MM-DD') };
	}

	// --- Main Synchronization Logic (MODIFIED to filter tasks) ---
	async syncTasks() {
		if (!this.calendar) { new Notice('Sync failed: Calendar API not ready. Authenticate?', 7000); console.error('Sync aborted: Calendar API client unavailable.'); return; }
		if (!this.settings.calendarId) { new Notice('Sync failed: Target Calendar ID not set.', 7000); console.error('Sync aborted: Calendar ID not set.'); return; }
		console.log(`Starting sync with Calendar ID: ${this.settings.calendarId}`); new Notice('Sync started...', 3000);
		let createdCount = 0, updatedCount = 0, deletedCount = 0, skippedCount = 0, errorCount = 0;
		try {
			new Notice('Syncing: Fetching Obsidian tasks...', 2000);
			const obsidianTasks = await this.getObsidianTasks();

			const taskMap = { ...this.settings.taskMap }; // Local copy for manipulation
			const currentObsidianTaskIds = new Set<string>(); // Tasks currently in Obsidian (that meet sync criteria OR are completed)
			const syncableObsidianTaskIds = new Set<string>(); // Tasks meeting the start/due date criteria for create/update
			const processedGoogleEventIds = new Set<string>(); // GCal IDs processed in this run (created/updated/cancelled/skipped due to date criteria)

			// --- Pre-filter tasks and populate ID sets ---
			const filteredObsidianTasks: ObsidianTask[] = [];
			for (const task of obsidianTasks) {
				currentObsidianTaskIds.add(task.id); // Add all task IDs found in Obsidian initially
                const googleEventId = taskMap[task.id]; // Get potential existing GCal ID

				// **FILTERING LOGIC START**
                // Only include tasks that have BOTH startDate AND dueDate for creation/update sync
				if (task.startDate && task.dueDate) {
                    syncableObsidianTaskIds.add(task.id);
                    filteredObsidianTasks.push(task);
                    if (googleEventId) processedGoogleEventIds.add(googleEventId); // Mark corresponding GCal ID as potentially processed
				}
                // Also include completed tasks that were previously synced, so they can be marked as cancelled
                else if (task.isCompleted && googleEventId) {
                    filteredObsidianTasks.push(task); // Keep completed task for cancellation check
                    processedGoogleEventIds.add(googleEventId); // Mark corresponding GCal ID as potentially processed
                }
                // Tasks that DON'T meet criteria (missing start/due OR completed without prior sync)
                else {
					console.log(`Skipping task "${task.summary}" (Obs ID: ${task.id}): Does not meet sync criteria (requires Start & Due date, or be Completed & Previously Synced).`);
					skippedCount++;
					// If this task was previously synced but no longer meets criteria (e.g., date removed),
                    // keep its GCal ID marked as processed so it's not deleted later.
                    // The event will remain in Google Calendar unless manually deleted or the task is completed.
                    if (googleEventId) {
                        processedGoogleEventIds.add(googleEventId);
                    }
				}
                // **FILTERING LOGIC END**
			}
            console.log(`Found ${obsidianTasks.length} total tasks, ${filteredObsidianTasks.length} meet sync criteria or are completed.`);

			// --- Fetch Existing Google Calendar Events ---
			let existingEvents: calendar_v3.Schema$Event[] = []; let nextPageToken: string | undefined = undefined;
			new Notice('Syncing: Fetching Google Calendar events...', 3000);
			try {
				const sTime = Date.now();
				do {
					const response: GaxiosResponse<calendar_v3.Schema$Events> = await this.calendar.events.list({
						calendarId: this.settings.calendarId,
						privateExtendedProperty: ['isGcalSync=true'], // Only fetch events created by this plugin
						showDeleted: false,
						maxResults: 250,
						pageToken: nextPageToken,
						singleEvents: false // Fetch recurring masters too
					});
					if (response.data.items) {
						existingEvents = existingEvents.concat(response.data.items);
					}
					nextPageToken = response.data.nextPageToken ?? undefined;
				} while (nextPageToken);
				console.log(`Fetched ${existingEvents.length} GCal events marked by this plugin in ${Date.now() - sTime}ms.`);
			}
			catch (e: any) { console.error('CRITICAL Error fetching GCal events:', e); const eMsg = e.response?.data?.error?.message || e.message || 'Unknown'; new Notice(`Error fetching GCal events: ${eMsg}. Sync aborted.`, 10000); errorCount++; return; }

			// --- Map Existing Google Events by Obsidian Task ID ---
			const googleEventMap = new Map<string, calendar_v3.Schema$Event>();
			existingEvents.forEach(event => {
				const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
				if (obsId && event.id) {
					const exMap = googleEventMap.get(obsId);
					// Prefer the most recently updated event if duplicates somehow exist (unlikely with ID)
					if (!exMap || (event.updated && exMap.updated && moment(event.updated).isAfter(moment(exMap.updated)))) {
						googleEventMap.set(obsId, event);
					}
					// Correct task map if inconsistency found (e.g., GCal ID changed)
					if (!taskMap[obsId] || taskMap[obsId] !== event.id) {
						if (taskMap[obsId]) console.warn(`Task map correction: ${obsId} mapping updated from ${taskMap[obsId]} to ${event.id}`);
						taskMap[obsId] = event.id;
					}
				} else if(event.id && event.extendedProperties?.private?.['isGcalSync'] === 'true') {
					// This event was created by the plugin but lacks the Obsidian Task ID.
					// This might happen if the task was deleted and recreated quickly or due to an error.
					// We don't have a direct link back, so we'll ignore it for updates/cancellation
					// but it WILL be considered for deletion later if no current Obsidian task matches it.
					console.warn(`GCal event (ID: ${event.id}) marked by plugin is missing 'obsidianTaskId' property.`);
				}
			});

			// --- Process Filtered Obsidian Tasks ---
			new Notice(`Syncing: Processing ${filteredObsidianTasks.length} eligible Obsidian tasks...`, 3000);
			for (const task of filteredObsidianTasks) {
				const existingEvent = googleEventMap.get(task.id);
				const googleEventId = existingEvent?.id || taskMap[task.id]; // Use map as fallback

				// **Handle Completed Tasks** (These passed the filter only if previously synced)
				if (task.isCompleted) {
					if (googleEventId && existingEvent && existingEvent.status !== 'cancelled') {
						try {
							// Mark the existing GCal event as cancelled
							await this.calendar.events.patch({
								calendarId: this.settings.calendarId,
								eventId: googleEventId,
								requestBody: { status: 'cancelled' }
							});
							console.log(`Marked GCal event as cancelled: "${task.summary}" (Obs ID: ${task.id}, GCal ID: ${googleEventId})`);
							taskMap[task.id] = googleEventId; // Ensure map is consistent
							updatedCount++;
						} catch (e: any) {
							// Handle cases where the event might have been deleted manually in GCal
							if (e.code === 404 || e.code === 410 || e.response?.status === 404 || e.response?.status === 410) {
								console.warn(`GCal event ${googleEventId} for completed task "${task.summary}" not found for cancellation. Removing from map.`);
								delete taskMap[task.id];
							} else {
								console.error(`Error cancelling GCal event ${googleEventId} for task "${task.summary}":`, e);
								errorCount++;
							}
						}
					} else if (googleEventId && !existingEvent) {
						// Task map has an ID, but the event wasn't found in the initial fetch (maybe deleted?)
						console.warn(`Stale map entry for completed task "${task.summary}" (GCal ID: ${googleEventId}). Removing from map.`);
						delete taskMap[task.id];
						skippedCount++; // Skipped cancellation because event was gone
					} else {
						// Completed task was never synced (no googleEventId) or already cancelled
						skippedCount++;
					}
					continue; // Move to the next task
				}

				// **Handle Active Tasks** (These passed the filter because they have start & due dates)
				const eventPayload = this.mapObsidianTaskToGoogleEvent(task); // Map task to GCal event structure

				try {
					if (googleEventId && existingEvent) {
						// **Update Existing Event**
						if (this.needsUpdate(existingEvent, eventPayload)) {
							const resp = await this.calendar.events.update({
								calendarId: this.settings.calendarId,
								eventId: googleEventId,
								requestBody: eventPayload
							});
							const uId = resp.data.id!;
                            if (uId !== googleEventId) console.warn(`GCal ID changed on update for task ${task.id}: ${googleEventId} -> ${uId}`);
							taskMap[task.id] = uId; // Update map just in case ID changed
							updatedCount++;
                            console.log(`Updated GCal event: "${task.summary}" (Obs ID: ${task.id}, GCal ID: ${uId})`);
						} else {
							// No changes needed
							taskMap[task.id] = googleEventId; // Ensure map is correct
							skippedCount++;
						}
					} else {
						// **Create New Event**
						if (googleEventId && !existingEvent) {
							// Task map had an ID, but event not found. Likely deleted in GCal. Recreate.
							console.warn(`Stale map entry for task "${task.summary}" (GCal ID: ${googleEventId}). Recreating event.`);
							delete taskMap[task.id]; // Remove old mapping before creating new
						}
						const resp = await this.calendar.events.insert({
							calendarId: this.settings.calendarId,
							requestBody: eventPayload
						});
						const cId = resp.data.id!;
						console.log(`Created GCal event: "${task.summary}" (Obs ID: ${task.id}, GCal ID: ${cId})`);
						taskMap[task.id] = cId; // Store the new mapping
						createdCount++;
						processedGoogleEventIds.add(cId); // Ensure this new ID is marked as processed
					}
				} catch (e: any) {
					const gIdInfo = googleEventId ? `GCal ID: ${googleEventId}` : 'No GCal ID';
					console.error(`Error syncing task "${task.summary}" (Obs ID: ${task.id}, ${gIdInfo})`, e);
					const eMsg = e.response?.data?.error?.message || e.message || "API error";
					new Notice(`Error sync task "${task.summary.slice(0,25)}...": ${eMsg}`, 10000);
					errorCount++;
                    // If create/update failed, ensure the task ID is removed from the map if it existed
                    // to prevent issues on subsequent runs or deletion checks.
                    // if (googleEventId) delete taskMap[task.id]; // Optional: Be cautious about removing map on error
				}
			}

			// --- Check for Deletions in Google Calendar ---
			new Notice('Syncing: Checking for deleted Obsidian tasks...', 2000);
			// Find entries in the task map where the Obsidian task ID is NO LONGER in the set of *all* current Obsidian tasks
			const entriesToDelete = Object.entries(taskMap).filter(([obsId, gId]) =>
                gId && !currentObsidianTaskIds.has(obsId)
            );

			if (entriesToDelete.length > 0) {
				console.log(`Found ${entriesToDelete.length} GCal events corresponding to Obsidian tasks that were removed or no longer exist.`);
				for (const [obsId, gId] of entriesToDelete) {
					try {
						await this.calendar.events.delete({
							calendarId: this.settings.calendarId,
							eventId: gId
						});
						console.log(`Deleted GCal event ID: ${gId} (was linked to removed Obs ID: ${obsId})`);
						delete taskMap[obsId]; // Remove from map after successful deletion
						deletedCount++;
					} catch (e: any) {
						// Handle cases where the event was already deleted in GCal
						if (e.code === 404 || e.code === 410 || e.response?.status === 404 || e.response?.status === 410) {
							console.warn(`GCal event ${gId} (for removed Obs ID: ${obsId}) not found for deletion. Removing from map.`);
							delete taskMap[obsId]; // Remove from map even if deletion failed because it's gone
						} else {
							console.error(`Error deleting GCal event ${gId} (for removed Obs ID: ${obsId}):`, e);
							errorCount++;
							// Keep the entry in the map if deletion failed, to retry next time
						}
					}
				}
			}

            // --- Also check for GCal events created by the plugin but orphaned ---
            // These are events fetched from GCal that have our plugin property but their obsId isn't in the taskMap anymore
            const orphanedGcalEvents = existingEvents.filter(event => {
                const obsId = event.extendedProperties?.private?.['obsidianTaskId'];
                return event.id && obsId && !taskMap[obsId]; // Event has an obsId, but that obsId is not in our current map
            });

            if (orphanedGcalEvents.length > 0) {
                 console.log(`Found ${orphanedGcalEvents.length} potentially orphaned GCal events (plugin-created but obsId not in current taskMap). Deleting...`);
                 for (const event of orphanedGcalEvents) {
                    try {
                        await this.calendar.events.delete({ calendarId: this.settings.calendarId, eventId: event.id! });
                        console.log(`Deleted orphaned GCal event ID: ${event.id} (had Obs ID: ${event.extendedProperties?.private?.['obsidianTaskId']})`);
                        deletedCount++;
                    } catch (e: any) {
                         if (e.code === 404 || e.code === 410 || e.response?.status === 404 || e.response?.status === 410) {
                            console.warn(`Orphaned GCal event ${event.id} not found for deletion.`);
                         } else {
                            console.error(`Error deleting orphaned GCal event ${event.id}:`, e);
                            errorCount++;
                         }
                    }
                 }
            }


			// --- Save Updated Task Map ---
			if (JSON.stringify(taskMap) !== JSON.stringify(this.settings.taskMap)) {
				console.log("Task map changed, saving.");
				this.settings.taskMap = taskMap;
				await this.saveData(this.settings);
			}

			// --- Final Summary ---
			const summary = `Sync complete: ${createdCount} added, ${updatedCount} updated/cancelled, ${deletedCount} deleted, ${skippedCount} skipped (no dates/no change).${errorCount > 0 ? ` ${errorCount} errors.` : ''}`;
			console.log("Sync finished. ", summary);
			new Notice(summary, errorCount > 0 ? 15000 : 7000);

		} catch (error: any) {
			console.error('CRITICAL error during sync:', error);
			errorCount++;
			new Notice(`Sync failed critically: ${error.message}. Check console.`, 15000);
		}
		finally {
			// Ensure counts are numbers, default to 0 if undefined/NaN
			const finalCreated = createdCount || 0;
			const finalUpdated = updatedCount || 0;
			const finalDeleted = deletedCount || 0;
			const finalSkipped = skippedCount || 0;
			const finalErrors = errorCount || 0;
			console.log(`Sync counts - Created: ${finalCreated}, Updated/Cancelled: ${finalUpdated}, Deleted: ${finalDeleted}, Skipped: ${finalSkipped}, Errors: ${finalErrors}`);
		}
	}


	// Compares events to see if update is needed (UNCHANGED)
	needsUpdate(existingEvent: calendar_v3.Schema$Event, newPayload: GoogleCalendarEventInput): boolean {
		const isDifferent = (key: keyof GoogleCalendarEventInput | keyof calendar_v3.Schema$Event) => JSON.stringify(existingEvent[key as keyof calendar_v3.Schema$Event] ?? null) !== JSON.stringify(newPayload[key as keyof GoogleCalendarEventInput] ?? null);
		if (isDifferent('summary')) return true; if (isDifferent('description')) return true; if (isDifferent('status')) return true; if (isDifferent('start')) return true; if (isDifferent('end')) return true;
		const oldRecurrence = existingEvent.recurrence ?? []; const newRecurrence = newPayload.recurrence ?? []; const normalizeRRule = (r: string) => r.startsWith('RRULE:') ? r.substring(6).trim() : r.trim(); const normOld = oldRecurrence.map(normalizeRRule).sort(); const normNew = newRecurrence.map(normalizeRRule).sort(); if (JSON.stringify(normOld) !== JSON.stringify(normNew)) return true;
		// Compare extended properties too, in case obsidianTaskId was missing/changed (less likely)
        if (isDifferent('extendedProperties')) return true;
		return false;
	}
}


// --- Settings Tab UI (MODIFIED - Removed sync date prioritization options) ---
class GoogleCalendarSyncSettingTab extends PluginSettingTab {
	plugin: GoogleCalendarTasksSyncPlugin;

	constructor(app: App, plugin: GoogleCalendarTasksSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Google Calendar Sync Settings' });

		// --- Google Authentication Section (UNCHANGED) ---
		containerEl.createEl('h3', { text: 'Google Authentication' });
		new Setting(containerEl).setName('Client ID').setDesc('Your Google OAuth Client ID.').addText(text => text.setPlaceholder('Enter Client ID').setValue(this.plugin.settings.clientId).onChange(async v => { this.plugin.settings.clientId = v.trim(); await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Client Secret').setDesc('Your Google OAuth Client Secret.').addText(text => { text.setPlaceholder('Enter Client Secret').inputEl.type = 'password'; text.setValue(this.plugin.settings.clientSecret).onChange(async v => { this.plugin.settings.clientSecret = v.trim(); await this.plugin.saveSettings(); }); });

		containerEl.createEl('h4', { text: 'Authentication Redirect (Local Server)' });
		containerEl.createDiv('setting-item-description').append(
			'Authentication uses a temporary local web server (HTTP Loopback) to receive the code from Google. ',
			createEl('strong', { text: 'This is the only supported method.' })
		);

		// Port Setting (always shown now)
		new Setting(containerEl)
			.setName('Local Server Port (Initial Attempt)')
			.setDesc('Port the plugin first tries for the local server (1024-65535). If busy, it tries subsequent ports automatically. Update Google Console URI if port changes.')
			.addText((text: TextComponent) => {
				text.inputEl.type = 'number'; text.inputEl.min = '1024'; text.inputEl.max = '65535';
				text.setPlaceholder(DEFAULT_SETTINGS.loopbackPort.toString()).setValue(this.plugin.settings.loopbackPort.toString())
				.onChange(async v => {
					const portNum = parseInt(v, 10); const currentPortSetting = this.plugin.settings.loopbackPort;
					if (!isNaN(portNum) && portNum >= 1024 && portNum <= 65535) {
						 if (currentPortSetting !== portNum) { this.plugin.settings.loopbackPort = portNum; await this.plugin.saveSettings(); this.display(); new Notice(`Port setting changed to ${portNum}.`, 5000); }
					} else if (v !== currentPortSetting.toString()) { new Notice('Invalid Port (1024-65535).', 5000); text.setValue(currentPortSetting.toString()); }
				});
			});

		// Effective Redirect URI (always shown now)
		const effectiveRedirectUri = this.plugin.getRedirectUri();
		new Setting(containerEl)
			.setName('Redirect URI (Required for Google Console)')
			.setDesc('Add this EXACT URI to "Authorized redirect URIs" in Google Cloud Console. If the server auto-starts on a different port, you MUST update the URI in Google Console.')
			.addText(text => {
				text.inputEl.style.width = "100%"; text.inputEl.readOnly = true; text.setValue(effectiveRedirectUri).setDisabled(true);
				const copyButton = new ExtraButtonComponent(text.inputEl.parentElement!).setIcon('copy').setTooltip('Copy URI').onClick(() => { navigator.clipboard.writeText(effectiveRedirectUri).then(() => new Notice('Redirect URI copied!', 2000), () => new Notice('Copy failed.', 3000)); });
				copyButton.extraSettingsEl.addClass('clickable-icon');
			 });

		// Authentication Status (UNCHANGED)
		const hasTokens = !!this.plugin.settings.tokens; const hasAccessToken = !!this.plugin.settings.tokens?.access_token; const isTokenCurrentlyValid = this.plugin.isTokenValid(false); const canRefreshToken = this.plugin.isTokenValid(true);
		let statusDesc = 'Not authenticated.'; let statusIcon = 'x-circle'; let statusColor = 'var(--text-error)';
		if (hasTokens) { if (hasAccessToken && isTokenCurrentlyValid) { statusDesc = 'Authenticated. Access token active.'; statusIcon = 'check-circle'; statusColor = 'var(--text-success)'; } else if (canRefreshToken) { statusDesc = 'Authenticated, but access token expired/missing. Auto-refresh enabled.'; statusIcon = 'refresh-cw'; statusColor = 'var(--text-warning)'; } else { statusDesc = 'Auth expired or incomplete (no refresh token). Re-authenticate needed.'; statusIcon = 'alert-circle'; statusColor = 'var(--text-error)'; } }
		new Setting(containerEl).setName('Authentication Status').setDesc(statusDesc).addExtraButton(button => { button.setIcon(statusIcon).setTooltip(statusDesc).extraSettingsEl.style.color = statusColor; })
			.addButton(button => button.setButtonText(hasTokens ? 'Re-authenticate' : 'Authenticate').setTooltip(hasTokens ? 'Re-authorize with Google' : 'Start Google authentication').setClass(hasTokens ? '' : 'mod-cta').onClick(() => { this.plugin.authenticate(); }));

		// --- Synchronization Settings Section (UNCHANGED title, contents mostly same) ---
		containerEl.createEl('h3', { text: 'Synchronization Settings' });
        containerEl.createEl('p', { text: 'Only tasks with BOTH a Start Date (🛫) AND a Due Date (📅) will be synchronized.', cls: 'setting-item-description' }); // Add note about sync criteria

		new Setting(containerEl).setName('Target Google Calendar ID').setDesc('ID of the Google Calendar (use "primary" for default).').addText(text => text.setPlaceholder('primary').setValue(this.plugin.settings.calendarId).onChange(async v => { this.plugin.settings.calendarId = v.trim() || 'primary'; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Automatic Background Sync').setDesc('Periodically sync tasks automatically.').addToggle(toggle => toggle.setValue(this.plugin.settings.autoSync).onChange(async v => { this.plugin.settings.autoSync = v; await this.plugin.saveSettings(); this.display(); }));
		if (this.plugin.settings.autoSync) {
			new Setting(containerEl).setName('Sync Interval (minutes)').setDesc('How often to sync (min 1).').addText(text => { text.inputEl.type = 'number'; text.inputEl.min = '1'; text.setValue(this.plugin.settings.syncIntervalMinutes.toString()).setPlaceholder(DEFAULT_SETTINGS.syncIntervalMinutes.toString()).onChange(async v => { let minutes = parseInt(v, 10); const current = this.plugin.settings.syncIntervalMinutes; if (isNaN(minutes) || minutes < 1) minutes = 1; if (current !== minutes) { this.plugin.settings.syncIntervalMinutes = minutes; await this.plugin.saveSettings(); text.setValue(minutes.toString()); } else if (v !== minutes.toString()) { text.setValue(minutes.toString()); } }); });
		}

		// --- Sync Behavior Options Section (MODIFIED - Simplified) ---
		containerEl.createEl('h3', { text: 'Sync Behavior Options' });

		new Setting(containerEl).setName('Event Timing').setDesc('Google Calendar events use Start Date (🛫) for the event start and Due Date (📅) for the event end. (Only tasks with both dates are synced). See README for details on time/all-day handling.');

		// --- REMOVED Date Prioritization & Use Start/Scheduled Date Toggles ---

		new Setting(containerEl).setName('Default Event Duration (minutes)').setDesc('Duration used if both Start Date and Due Date have times, but Due time is before Start time (min 5).').addText((text: TextComponent) => {
			text.inputEl.type = 'number'; text.inputEl.min = '5'; const current = this.plugin.settings.defaultEventDurationMinutes; text.setValue(current.toString()).setPlaceholder(DEFAULT_SETTINGS.defaultEventDurationMinutes.toString())
				.onChange(async v => { const dur = parseInt(v, 10); let newDur = current; if (isNaN(dur) || dur < 5) newDur = 5; else newDur = dur; if (current !== newDur) { this.plugin.settings.defaultEventDurationMinutes = newDur; await this.plugin.saveSettings(); text.setValue(newDur.toString()); } else if(v !== newDur.toString()){ text.setValue(newDur.toString()); } });
		});

		containerEl.createEl('h4', { text: 'Google Event Description Content' });
		containerEl.createDiv({cls: 'setting-item-description', text: 'Select details to include in the event description for synced tasks.'});

		new Setting(containerEl).setName('Add Priority').setDesc('Include task priority (e.g., "Priority: 🔼 Medium").').addToggle(toggle => toggle.setValue(this.plugin.settings.syncPriorityToDescription).onChange(async v => { this.plugin.settings.syncPriorityToDescription = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Add Tags').setDesc('Include Obsidian #tags.').addToggle(toggle => toggle.setValue(this.plugin.settings.syncTagsToDescription).onChange(async v => { this.plugin.settings.syncTagsToDescription = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Add Scheduled Date (⏳)').setDesc('Include the scheduled date in the description (even though it doesn\'t affect sync timing).').addToggle(toggle => toggle.setValue(this.plugin.settings.syncScheduledDateToDescription).onChange(async v => { this.plugin.settings.syncScheduledDateToDescription = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName('Add Block Link').setDesc('Include Obsidian link to the task block ([[Note#^blockid]]).').addToggle(toggle => toggle.setValue(this.plugin.settings.syncBlockLinkToDescription).onChange(async v => { this.plugin.settings.syncBlockLinkToDescription = v; await this.plugin.saveSettings(); }));

		// --- Manual Actions Section (UNCHANGED) ---
		containerEl.createEl('h3', { text: 'Manual Actions & Debug' });
		new Setting(containerEl).setName('Force Sync Now').setDesc('Manually trigger a synchronization cycle.').addButton(button => button.setButtonText('Sync Now').setIcon('sync').setTooltip('Run sync immediately').onClick(async () => { if (!this.plugin.settings.tokens) {new Notice("Authenticate first.", 3000); return;} new Notice('Manual sync triggered...', 2000); await this.plugin.syncTasks(); }));
		new Setting(containerEl).setName('Clear Task Map Cache').setDesc('⚠️ Resets stored links between tasks and events. May cause duplicates on next sync. Use if sync is broken.').addButton(button => button.setButtonText('Clear Task Map').setIcon('trash-2').setWarning().onClick(async () => { if (confirm('Clear task map cache? Tasks will be re-linked or duplicated on the next sync.')) { this.plugin.settings.taskMap = {}; await this.plugin.saveData(this.plugin.settings); new Notice('Task map cleared.'); this.display(); } }));
		const taskCount = Object.keys(this.plugin.settings.taskMap).length; containerEl.createEl('p', { text: `Tracking links for ${taskCount} task(s) in cache.`, cls: 'setting-item-description' });
	}
}