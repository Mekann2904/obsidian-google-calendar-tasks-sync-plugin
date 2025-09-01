let dev = false;

export function setDevLogging(flag: boolean) {
  dev = !!flag;
}

export const logger = {
  debug: (...args: any[]) => { if (dev) console.log(...args); },
  info:  (...args: any[]) => { if (dev) (console.info ? console.info(...args) : console.log(...args)); },
  warn:  (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
  time:  (label: string) => { if (dev && console.time) console.time(label); },
  timeEnd: (label: string) => { if (dev && console.timeEnd) console.timeEnd(label); },
};
