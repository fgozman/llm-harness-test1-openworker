// Text styling. Code that prints receives a Style, so tests can use plain text.

export type Paint = (text: unknown) => string;

export interface Style {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  magenta: Paint;
  cyan: Paint;
}

const ansi = (code: string): Paint => (text) => `\x1b[${code}m${text}\x1b[0m`;
const plain: Paint = (text) => String(text);

/** ANSI colors when `enabled` (i.e. writing to a real terminal), plain text otherwise. */
export function terminalStyle(enabled: boolean): Style {
  if (!enabled) return PLAIN_STYLE;
  return {
    bold: ansi('1'),
    dim: ansi('2'),
    red: ansi('31'),
    green: ansi('32'),
    yellow: ansi('33'),
    magenta: ansi('35'),
    cyan: ansi('36'),
  };
}

export const PLAIN_STYLE: Style = {
  bold: plain, dim: plain, red: plain, green: plain, yellow: plain, magenta: plain, cyan: plain,
};
