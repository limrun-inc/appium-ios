/**
 * Parses the old-style (NeXTSTEP) property lists that `simctl appinfo` and
 * `simctl listapps` print, such as `{ CFBundleName = Safari; Path = "/a b"; }`.
 *
 * Values come back as strings, arrays and plain objects; the format has no
 * numbers or booleans of its own.
 */
export function parseAsciiPlist(text: string): unknown {
  const parser = new Parser(text);
  const value = parser.value();
  parser.skipSpace();
  if (!parser.done()) {
    throw parser.error('Unexpected trailing content');
  }
  return value;
}

// Characters that may appear in an unquoted string.
const BARE = /[A-Za-z0-9_$+/:.-]/;

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.pos >= this.text.length;
  }

  error(message: string): Error {
    return new Error(`${message} at offset ${this.pos} of old-style plist: ${this.text.slice(0, 200)}`);
  }

  skipSpace(): void {
    while (!this.done()) {
      const rest = this.text.slice(this.pos);
      if (/^\s/.test(rest)) {
        this.pos++;
      } else if (rest.startsWith('//')) {
        const end = this.text.indexOf('\n', this.pos);
        this.pos = end < 0 ? this.text.length : end + 1;
      } else if (rest.startsWith('/*')) {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end < 0) {
          throw this.error('Unterminated comment');
        }
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  value(): unknown {
    this.skipSpace();
    const c = this.text[this.pos];
    if (c === '{') {
      return this.dict();
    }
    if (c === '(') {
      return this.array();
    }
    if (c === '"') {
      return this.quoted();
    }
    return this.bare();
  }

  private expect(c: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== c) {
      throw this.error(`Expected '${c}'`);
    }
    this.pos++;
  }

  private dict(): Record<string, unknown> {
    this.expect('{');
    const result: Record<string, unknown> = {};
    for (;;) {
      this.skipSpace();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return result;
      }
      const key = this.value();
      if (typeof key !== 'string') {
        throw this.error('Dictionary keys must be strings');
      }
      this.expect('=');
      result[key] = this.value();
      this.expect(';');
    }
  }

  private array(): unknown[] {
    this.expect('(');
    const result: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.text[this.pos] === ')') {
        this.pos++;
        return result;
      }
      result.push(this.value());
      this.skipSpace();
      if (this.text[this.pos] === ',') {
        this.pos++;
      }
    }
  }

  private quoted(): string {
    this.pos++;
    let result = '';
    while (!this.done()) {
      const c = this.text[this.pos++];
      if (c === '"') {
        return result;
      }
      if (c !== '\\') {
        result += c;
        continue;
      }
      const e = this.text[this.pos++];
      const escapes: Record<string, string> = {n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\'};
      if (e in escapes) {
        result += escapes[e];
      } else if (e === 'U') {
        result += String.fromCharCode(parseInt(this.text.slice(this.pos, this.pos + 4), 16));
        this.pos += 4;
      } else {
        result += e;
      }
    }
    throw this.error('Unterminated string');
  }

  private bare(): string {
    const start = this.pos;
    while (!this.done() && BARE.test(this.text[this.pos])) {
      this.pos++;
    }
    if (start === this.pos) {
      throw this.error('Expected a value');
    }
    return this.text.slice(start, this.pos);
  }
}
