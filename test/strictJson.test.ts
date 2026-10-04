import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrictJson, StrictJsonError } from "../src/strictJson.ts";

const VALID_CASES: Array<{ name: string; text: string; expected: unknown }> = [
  { name: "null", text: "null", expected: null },
  { name: "true", text: "true", expected: true },
  { name: "false", text: "false", expected: false },
  { name: "integer", text: "42", expected: 42 },
  { name: "negative decimal exponent", text: "-12.5e+2", expected: -1250 },
  { name: "string escapes", text: '"a\\nb\\u0043\\""', expected: "a\nbC\"" },
  { name: "empty object", text: "{}", expected: {} },
  { name: "empty array", text: "[]", expected: [] },
  {
    name: "nested document with whitespace",
    text: ' {\n"a": 1,\t"b": [true, false, null], "c": {"d": "x"} }\r\n',
    expected: { a: 1, b: [true, false, null], c: { d: "x" } },
  },
  {
    name: "surrogate pair",
    text: '"\\uD83D\\uDE00"',
    expected: "😀",
  },
];

test("parseStrictJson accepts every well-formed unique-member document", () => {
  for (const c of VALID_CASES) {
    const parsed = JSON.parse(JSON.stringify(parseStrictJson(c.text)));
    assert.deepEqual(parsed, c.expected, c.name);
    assert.deepEqual(parsed, JSON.parse(c.text), `${c.name} matches JSON.parse`);
  }
});

const DUPLICATE_CASES: Array<{ name: string; text: string; path: string }> = [
  {
    name: "duplicate top-level member",
    text: '{"batchId":"b","batchId":"c"}',
    path: "$.batchId",
  },
  {
    name: "duplicate measurement member (the report scenario)",
    text: '{"records":[{"measurements":{"diagnosis":"malignant","diagnosis":"benign"}}]}',
    path: "$.records[0].measurements.diagnosis",
  },
  {
    name: "duplicate record member",
    text: '{"records":[{"recordId":"R-1","recordId":"R-2"}]}',
    path: "$.records[0].recordId",
  },
  {
    name: "duplicate nested object member",
    text: '{"a":{"b":{"k":1,"k":2}}}',
    path: "$.a.b.k",
  },
  {
    name: "duplicate member name with a quote in it uses bracket path",
    text: '{"a\\"b":1,"a\\"b":2}',
    path: '$["a\\"b"]',
  },
];

test("parseStrictJson rejects any object with duplicate member names", () => {
  for (const c of DUPLICATE_CASES) {
    assert.throws(
      () => parseStrictJson(c.text),
      (err: unknown) => {
        assert.ok(err instanceof StrictJsonError, `${c.name}: StrictJsonError`);
        const strict = err as StrictJsonError;
        assert.equal(strict.code, "duplicate_json_member", `${c.name}: code`);
        assert.equal(strict.path, c.path, `${c.name}: path`);
        // Diagnostics name the member, never either of the competing values.
        assert.ok(!strict.message.includes("malignant"), `${c.name}: no value echo`);
        assert.ok(!strict.message.includes("benign"), `${c.name}: no value echo`);
        return true;
      },
      c.name,
    );
  }
});

test("parseStrictJson rejects malformed JSON as invalid_json", () => {
  const malformed = [
    "{not json",
    '{"a":}',
    '{"a" 1}',
    "[1,]",
    "{,}",
    '"unterminated',
    '{"a":"x"} trailing',
    "01",
    "1.",
    "-",
    "tru",
    '{"a":"\\u00zz"}',
    '"bad\tescape"',
  ];
  for (const text of malformed) {
    assert.throws(
      () => parseStrictJson(text),
      (err: unknown) => {
        assert.ok(err instanceof StrictJsonError, text);
        assert.equal((err as StrictJsonError).code, "invalid_json", text);
        return true;
      },
      text,
    );
  }
});

test("parseStrictJson does not expose __proto__ on the parsed object", () => {
  const parsed = parseStrictJson('{"__proto__":{"polluted":true},"x":1}') as Record<
    string,
    unknown
  >;
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(Object.keys(parsed).sort(), ["__proto__", "x"]);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("parseStrictJson fails cleanly on nesting beyond the depth cap", () => {
  for (const bracket of [
    "[".repeat(5_000) + "1" + "]".repeat(5_000),
    "{".repeat(5_000) + '"a":1' + "}".repeat(5_000),
  ]) {
    assert.throws(
      () => parseStrictJson(bracket),
      (err: unknown) => err instanceof StrictJsonError,
      "deep nesting must produce StrictJsonError, not a stack overflow",
    );
  }
  // Realistic manifest-shaped depth is comfortably accepted.
  const realistic =
    '{"batchId":"b","records":[{"recordId":"r1","patientId":"p1","accessionId":"a1",' +
    '"relatedIds":[],"measurements":{"diagnosis":"benign"}}]}';
  assert.deepEqual(JSON.parse(JSON.stringify(parseStrictJson(realistic))), JSON.parse(realistic));
});
