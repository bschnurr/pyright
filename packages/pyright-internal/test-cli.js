const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

async function testCli() {
    // Find the Pyright CLI path - try multiple locations
    const possiblePaths = [
        path.resolve(__dirname, '../../../..', 'pyright', 'index.js'),
        path.resolve(__dirname, '../../../../packages/pyright/index.js'),
        path.resolve(__dirname, '../../../../../packages/pyright/index.js'),
    ];

    let pyrightCliPath;
    for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
            pyrightCliPath = possiblePath;
            break;
        }
    }

    if (!pyrightCliPath) {
        console.error(`Pyright CLI not found. Checked paths: ${possiblePaths.join(', ')}`);
        return;
    }

    console.log(`Using Pyright CLI at: ${pyrightCliPath}`);

    // Test that the CLI works
    exec(`node "${pyrightCliPath}" --version`, (error, stdout, stderr) => {
        if (error) {
            console.error('CLI test failed:', error);
        } else {
            console.log('CLI test successful:', stdout.trim());
        }
    });
}

testCli();
