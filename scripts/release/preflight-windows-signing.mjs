const certificate = process.env.WIN_CSC_LINK || process.env.CSC_LINK;
const password = process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD;

if (!certificate || !password) {
  console.error("Windows release signing is not configured. Set WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD (or the CSC_* equivalents). Local unsigned desktop builds remain available with npm run desktop:build.");
  process.exit(1);
}

console.log("Windows release signing inputs are present. Secret values were not printed.");
