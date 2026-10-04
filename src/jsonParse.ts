/**
 * JSON parsing with object member-name uniqueness as part of the contract.
 *
 * The JSON grammar (RFC 8259) permits duplicate names within an object even
 * though names SHOULD be unique. Runtime parsers resolve the ambiguity
 * silently by keeping the last value: the collapse happens while the object
 * is being constructed, so a reviver cannot even observe it, and a consumer
 * can never tell which value was the submitted fact. For pathology
 * manifests that is unacceptable — the service could persist and serve a
 * silently chosen measurement (e.g. "benign" over "malignant") while
 * callers believe their original text was accepted.
 *
 * Both trust boundaries therefore parse through here:
 *  - request bodies: any duplicate member name rejects the document outright
 *    (HTTP 400) before validation, and nothing is created or updated;
 *  - persisted entries recovered at startup: a duplicate member name makes
 *    the entry corrupt and the store fails closed (never served).
 *
 * A first pass walks the raw text with a strict RFC 8259 structural scanner
 * that records the (fully unescaped) member names of every open object; a
 * name appearing twice in one object aborts the scan. Only when the scan
 * proves uniqueness does JSON.parse construct the value, so value semantics
 * stay exactly the engine's. Key text is compared but never included in
 * errors, so submitted identifier values cannot leak through parser errors.
 */
export class DuplicateJsonKeyError extends SyntaxError {
  constructor() {
    super("duplicate object member name in JSON document");
    this.name = "DuplicateJsonKeyError";
  }
}

const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Parse JSON text, rejecting any object that contains duplicate member names. */
export function parseUniqueJson(text: string): unknown {
  assertUniqueObjectKeys(text);
  return JSON.parse(text);
}

/**
 * Single-pass structural validation. Throws {@link DuplicateJsonKeyError} on
 * a repeated member name within one object; throws SyntaxError on any
 * deviation from the JSON grammar.
 */
function assertUniqueObjectKeys(text: string): void {
  const length = text.length;
  let pos = 0;

  const isWhitespace = (code: number): boolean =>
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

  function skipWhitespace(): void {
    while (pos < length && isWhitespace(text.charCodeAt(pos))) pos++;
  }

  function expectLiteral(literal: string): void {
    if (text.startsWith(literal, pos)) {
      pos += literal.length;
      return;
    }
    throw new SyntaxError("invalid JSON");
  }

  /** Consume a JSON string (pos must point at the opening quote) and return its decoded value. */
  function scanString(): string {
    pos++; // opening quote
    let decoded = "";
    while (pos < length) {
      const ch = text[pos];
      if (ch === '"') {
        pos++;
        return decoded;
      }
      if (ch === "\\") {
        const escape = text[pos + 1];
        switch (escape) {
          case '"':
            decoded += '"';
            break;
          case "\\":
            decoded += "\\";
            break;
          case "/":
            decoded += "/";
            break;
          case "b":
            decoded += "\b";
            break;
          case "f":
            decoded += "\f";
            break;
          case "n":
            decoded += "\n";
            break;
          case "r":
            decoded += "\r";
            break;
          case "t":
            decoded += "\t";
            break;
          case "u": {
            const hex = text.slice(pos + 2, pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("invalid JSON");
            decoded += String.fromCharCode(parseInt(hex, 16));
            pos += 4; // advance past the hex digits (the shared +2 handles \u)
            break;
          }
          default:
            throw new SyntaxError("invalid JSON");
        }
        pos += 2; // backslash + escape char (already accounted for \u digits above)
        continue;
      }
      // Unescaped control characters are forbidden in JSON strings.
      if (ch.charCodeAt(0) < 0x20) throw new SyntaxError("invalid JSON");
      decoded += ch;
      pos++;
    }
    throw new SyntaxError("invalid JSON"); // unterminated string
  }

  function scanNumber(): void {
    NUMBER_PATTERN.lastIndex = pos;
    const match = NUMBER_PATTERN.exec(text);
    if (match === null) throw new SyntaxError("invalid JSON");
    pos += match[0].length;
  }

  function scanValue(): void {
    skipWhitespace();
    const ch = text[pos];
    if (ch === "{") return scanObject();
    if (ch === "[") return scanArray();
    if (ch === '"') {
      scanString();
      return;
    }
    if (ch === "t") return expectLiteral("true");
    if (ch === "f") return expectLiteral("false");
    if (ch === "n") return expectLiteral("null");
    scanNumber();
  }

  function scanArray(): void {
    pos++; // [
    skipWhitespace();
    if (text[pos] === "]") {
      pos++;
      return;
    }
    for (;;) {
      scanValue();
      skipWhitespace();
      const separator = text[pos];
      if (separator === ",") {
        pos++;
        continue;
      }
      if (separator === "]") {
        pos++;
        return;
      }
      throw new SyntaxError("invalid JSON");
    }
  }

  function scanObject(): void {
    pos++; // {
    skipWhitespace();
    if (text[pos] === "}") {
      pos++;
      return;
    }
    // Member names are compared after unescaping so that e.g. "a" and
    // "a" are recognized as the SAME member name, exactly as the
    // runtime parser would.
    const seenNames = new Set<string>();
    for (;;) {
      skipWhitespace();
      if (text[pos] !== '"') throw new SyntaxError("invalid JSON");
      const name = scanString();
      if (seenNames.has(name)) throw new DuplicateJsonKeyError();
      seenNames.add(name);

      skipWhitespace();
      if (text[pos] !== ":") throw new SyntaxError("invalid JSON");
      pos++;

      scanValue();
      skipWhitespace();
      const separator = text[pos];
      if (separator === ",") {
        pos++;
        continue;
      }
      if (separator === "}") {
        pos++;
        return;
      }
      throw new SyntaxError("invalid JSON");
    }
  }

  skipWhitespace();
  scanValue();
  skipWhitespace();
  if (pos !== length) throw new SyntaxError("invalid JSON");
}
