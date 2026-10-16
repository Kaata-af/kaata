// Compatibility entry point: all store sets share one Persian campaign.
const { generate } = require("./generate-store-assets.js");
if (require.main === module) {
  const files = generate({ only: ["tablet-7", "tablet-10"] });
  console.log(`Prepared ${files.length} Persian panels.`);
}
