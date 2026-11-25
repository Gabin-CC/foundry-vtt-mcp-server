/** Evaluate deterministic arithmetic and common dnd5e numeric functions without executing code. */
export function evaluateNumericFormula(value) {
  const source = String(value ?? "").replace(/\s+/g, "");
  if (!source || source.length > 2048) return NaN;
  let pos = 0;
  let depth = 0;

  const expression = () => {
    let result = product();
    while (source[pos] === "+" || source[pos] === "-") {
      const op = source[pos++];
      const right = product();
      result = op === "+" ? result + right : result - right;
    }
    return result;
  };
  const product = () => {
    let result = unary();
    while (source[pos] === "*" || source[pos] === "/") {
      const op = source[pos++];
      const right = unary();
      result = op === "*" ? result * right : result / right;
    }
    return result;
  };
  const unary = () => {
    if (source[pos] === "+") { pos++; return unary(); }
    if (source[pos] === "-") { pos++; return -unary(); }
    return primary();
  };
  const primary = () => {
    if (++depth > 32) throw new Error("Numeric expression is too deeply nested");
    try {
      if (source[pos] === "(") {
        pos++;
        const result = expression();
        if (source[pos++] !== ")") throw new Error("Unclosed parenthesis");
        return result;
      }
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(pos));
      if (number) {
        pos += number[0].length;
        return Number(number[0]);
      }
      const fn = /^(?:max|min|floor|ceil|round|abs)\b/.exec(source.slice(pos));
      if (!fn || source[pos + fn[0].length] !== "(") throw new Error("Unsupported numeric token");
      pos += fn[0].length + 1;
      const args = [];
      if (source[pos] !== ")") {
        args.push(expression());
        while (source[pos] === ",") { pos++; args.push(expression()); }
      }
      if (source[pos++] !== ")") throw new Error("Unclosed function");
      if ((fn[0] === "max" || fn[0] === "min") ? args.length < 1 : args.length !== 1) {
        throw new Error("Invalid number of function arguments");
      }
      return Math[fn[0]](...args);
    } finally { depth--; }
  };

  try {
    const result = expression();
    return pos === source.length && Number.isFinite(result) ? result : NaN;
  } catch { return NaN; }
}
