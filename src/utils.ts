import { GaxiosError } from 'gaxios'; // GaxiosError をインポート
import moment from 'moment'; // moment をインポート

// GaxiosError の型ガード関数
export function isGaxiosError(error: any): error is GaxiosError {
	return error && typeof error === 'object' && typeof error.message === 'string' && error.response !== undefined;
}

/**
 * moment.js のバリデーションをラップし、無効な場合に警告を出すヘルパー関数
 * @param timeString - 検証する時間文字列
 * @param format - moment.js に渡すフォーマット（オプション）
 * @param context - 警告メッセージのコンテキスト
 * @returns 有効な場合は moment オブジェクト、無効な場合は null
 */
export function validateMoment(timeString: string | undefined | null, format: string | string[] | undefined, context: string): moment.Moment | null {
    if (!timeString) return null;
    const m = moment(timeString, format, true); // strict モードでパース
    if (!m.isValid()) {
        console.warn(`無効な日付/時刻形式 (${context}): "${timeString}"`);
        return null;
    }
    return m;
}
