import { isSafeNumber, LosslessNumber } from "lossless-json";

/**
 * A strict JSON boundary with own-property object construction and exact number
 * tokens. Native JSON.parse is used ONLY for quoted string tokens. In particular,
 * assigning object["__proto__"] would lose valid PostgreSQL JSON/JSONB data.
 */
export function parseExactRecoveryJson(text: string): unknown {
  let position = 0;
  const fail = (): never => { throw new Error("Invalid recovery JSON"); };
  const whitespace = () => {
    while (position < text.length && /[ \t\r\n]/.test(text[position])) position++;
  };
  const string = (): string => {
    if (text[position] !== '"') return fail();
    const start = position++;
    while (position < text.length) {
      if (text[position] === "\\") {
        position += 2;
      } else if (text[position++] === '"') {
        // JSON.parse validates string escapes/control characters, but is never
        // allowed to parse numeric tokens or construct our objects.
        return JSON.parse(text.slice(start, position)) as string;
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 512) return fail();
    whitespace();
    const char = text[position];
    if (char === '"') return string();
    if (char === "{") {
      position++;
      whitespace();
      const object: Record<string, unknown> = {};
      if (text[position] === "}") { position++; return object; }
      for (;;) {
        const key = string();
        if (Object.prototype.hasOwnProperty.call(object, key)) return fail();
        whitespace();
        if (text[position++] !== ":") return fail();
        Object.defineProperty(object, key, {
          value: value(depth + 1), enumerable: true, writable: true, configurable: true,
        });
        whitespace();
        const separator = text[position++];
        if (separator === "}") return object;
        if (separator !== ",") return fail();
        whitespace();
      }
    }
    if (char === "[") {
      position++;
      whitespace();
      const array: unknown[] = [];
      if (text[position] === "]") { position++; return array; }
      for (;;) {
        array.push(value(depth + 1));
        whitespace();
        const separator = text[position++];
        if (separator === "]") return array;
        if (separator !== ",") return fail();
      }
    }
    for (const [keyword, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(keyword, position)) {
        position += keyword.length;
        return literal;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position))?.[0];
    if (!token) return fail();
    position += token.length;
    return isSafeNumber(token, { approx: false }) ? Number(token) : new LosslessNumber(token);
  };
  try {
    const result = value(0);
    whitespace();
    if (position !== text.length) return fail();
    return result;
  } catch {
    // Native string errors and numeric-library errors can quote private input.
    return fail();
  }
}