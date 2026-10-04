/**
 * Strict JSON parsing with unique object member names.
 *
 * RFC 8259 only *recommends* that object member names be unique, and the
 * standard `JSON.parse` silently keeps the LAST value when an object carries
 * duplicates. A payload such as
 *
 *   {"measurements": {"diagnosis": "malignant", "diagnosis": "benign"}}
 *
 * is therefore ambiguous: after a loose parse the service cannot tell which
 * value the originator meant, yet it would happily persist one of them.
 *
 * Unique member names are part of this service's input contract, so both the
 * inbound HTTP path and the recovery loader parse through {@link parseStrictJson}:
 * a duplicated member fails the ENTIRE document before any validation or
 * persistence, and the reported {@link StrictJsonError.path} points at the
 * offending member (member names only — never member values).
 */

export type StrictJsonErrorCode = "invalid_json" | "duplicate_json_member";

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  /** JSON path of the offending member/value, e.g. `$.records[0].measurements.diagnosis`. */
  readonly path: string;

  constructor(code: StrictJsonErrorCode, path: string, message: string) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
    this.path = path;
  }
}

/** Matches a JSON number exactly at the regex's sticky position. */
const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
/** Segments safe to render with dot notation in a diagnostic path. */
const IDENTIFIER_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
/**
 * Maximum nesting depth of objects/arrays. A contract-valid manifest never
 * nests deeper than a handful of levels (measurement values are scalars); the
 * cap exists so pathologically nested input fails with a clean invalid_json
 * error instead of exhausting the call stack.
 */
const MAX_JSON_NESTING_DEPTH = 1_000;

export function parseStrictJson(input: string): unknown {
  const parser = new StrictJsonParser(input);
  const value = parser.parseValue("$", 0);
  parser.skipWhitespace();
  if (!parser.atEnd) {
    throw parser.syntaxError("$", "unexpected trailing data after JSON value");
  }
  return value;
}

class StrictJsonParser {
  private index = 0;
  private readonly length: number;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
    this.length = input.length;
  }

  get atEnd(): boolean {
    return this.index >= this.length;
  }

  skipWhitespace(): void {
    while (this.index < this.length && WHITESPACE.has(this.input[this.index])) {
      this.index++;
    }
  }

  syntaxError(path: string, message: string): StrictJsonError {
    return new StrictJsonError("invalid_json", path, message);
  }

  parseValue(path: string, depth: number): unknown {
    this.skipWhitespace();
    if (this.atEnd) {
      throw this.syntaxError(path, "unexpected end of input while parsing a JSON value");
    }
    const char = this.input[this.index];
    if (char === "{") return this.parseObject(path, depth);
    if (char === "[") return this.parseArray(path, depth);
    if (char === '"') return this.parseString(path);
    if (char === "-" || (char >= "0" && char <= "9")) return this.parseNumber(path);
    if (char === "t" || char === "f" || char === "n") return this.parseLiteral(path);
    throw this.syntaxError(path, "unexpected character while parsing a JSON value");
  }

  private parseObject(path: string, depth: number): Record<string, unknown> {
    if (depth > MAX_JSON_NESTING_DEPTH) {
      throw this.syntaxError(path, "JSON nesting depth exceeds the supported limit");
    }
    // Null prototype so exotic member names (e.g. "__proto__") cannot touch a
    // prototype; callers only enumerate / read own properties anyway.
    const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();

    this.index++; // opening "{"
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index++;
      return object;
    }

    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw this.syntaxError(path, "expected a quoted object member name");
      }
      const key = this.parseString(path);
      const memberPath = this.memberPath(path, key);
      if (seen.has(key)) {
        throw new StrictJsonError(
          "duplicate_json_member",
          memberPath,
          `duplicate JSON object member at ${memberPath}`,
        );
      }
      seen.add(key);

      this.skipWhitespace();
      if (this.peek() !== ":") {
        throw this.syntaxError(memberPath, "expected ':' after object member name");
      }
      this.index++;

      object[key] = this.parseValue(memberPath, depth + 1);

      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.index++;
        continue;
      }
      if (next === "}") {
        this.index++;
        return object;
      }
      throw this.syntaxError(memberPath, "expected ',' or '}' after object member value");
    }
  }

  private parseArray(path: string, depth: number): unknown[] {
    if (depth > MAX_JSON_NESTING_DEPTH) {
      throw this.syntaxError(path, "JSON nesting depth exceeds the supported limit");
    }
    const array: unknown[] = [];
    this.index++; // opening "["
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index++;
      return array;
    }

    for (;;) {
      array.push(this.parseValue(`${path}[${array.length}]`, depth + 1));
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.index++;
        continue;
      }
      if (next === "]") {
        this.index++;
        return array;
      }
      throw this.syntaxError(path, "expected ',' or ']' after array element");
    }
  }

  /**
   * Scan the quoted token and decode it via the built-in parser: the extracted
   * substring is a complete JSON string token, so `JSON.parse` validates every
   * escape while the manual scan rejects unescaped control characters.
   */
  private parseString(path: string): string {
    const start = this.index;
    this.index++; // opening quote
    while (this.index < this.length) {
      const char = this.input[this.index];
      if (char === '"') {
        const token = this.input.slice(start, this.index + 1);
        this.index++;
        try {
          return JSON.parse(token) as string;
        } catch {
          throw this.syntaxError(path, "invalid escape sequence in JSON string");
        }
      }
      if (char === "\\") {
        // Skip the escaped character blindly; "\uXXXX" hex digits and an
        // escaped quote/backslash are ordinary characters for this scan, and
        // JSON.parse on the complete token still validates the escape.
        this.index += 2;
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        throw this.syntaxError(path, "unescaped control character in JSON string");
      }
      this.index++;
    }
    throw this.syntaxError(path, "unterminated JSON string");
  }

  private parseNumber(path: string): number {
    NUMBER_PATTERN.lastIndex = this.index;
    const match = NUMBER_PATTERN.exec(this.input);
    if (match === null) {
      throw this.syntaxError(path, "invalid JSON number");
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseLiteral(path: string): boolean | null {
    if (this.input.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.input.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.input.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    throw this.syntaxError(path, "invalid JSON literal");
  }

  private peek(): string | undefined {
    return this.index < this.length ? this.input[this.index] : undefined;
  }

  private memberPath(parent: string, key: string): string {
    if (IDENTIFIER_SEGMENT.test(key)) {
      return `${parent}.${key}`;
    }
    return `${parent}[${JSON.stringify(key)}]`;
  }
}
