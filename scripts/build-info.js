// @ts-check
const buildInfo = require('../ui/lib/build-info');

if (require.main === module) {
    const info = buildInfo.generateBuildInfo();
    console.log(`Build info generated: v${info.version} (build #${info.buildNumber}, ${info.buildDate})`);
}

module.exports = buildInfo;
