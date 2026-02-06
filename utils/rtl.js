const reshape = require("arabic-persian-reshaper");
const bidi = require("bidi-js");

const bidiEngine = new bidi();

function rtl(text = "") {
  if (!text) return "";
  const reshaped = reshape(text);
  return bidiEngine.getDisplay(reshaped);
}

module.exports = { rtl };
