module.exports = function (grunt) {

    require('dotenv').config(); // Loads PAT from .env if it exists
    const fs = require('fs'); // For saving token to .env
    const readline = require('readline'); // For interactive input

    // Project configuration.
    grunt.initConfig({
        exec: {
            package_dev: {
                command: "tfx extension create  --manifests vss-extension.json --overrides-file configs/dev.json --output-path ../dist",
                stdout: true,
                stderr: true
            },
            package_release: {
                command: "tfx extension create  --manifests vss-extension.json --overrides-file configs/release.json --output-path ../dist",
                stdout: true,
                stderr: true
            },
            package_release_test: {
                command: "tfx extension create  --manifests vss-extension.json --overrides-file configs/release-test.json --output-path ../dist",
                stdout: true,
                stderr: true
            }
        },
        copy: {
            scripts: {
                files: [{
                    expand: true, 
                    flatten: true, 
                    src: ["node_modules/vss-web-extension-sdk/lib/VSS.SDK.min.js"], 
                    dest: "lib",
                    filter: "isFile" 
                }]
            }
        },

        clean: ["../dist/*.vsix"],

    });
    
    // Load the plugin that provides the "uglify" task
    grunt.loadNpmTasks("grunt-exec");
    grunt.loadNpmTasks("grunt-contrib-copy");
    grunt.loadNpmTasks('grunt-contrib-clean');

    // Default task(s)
    grunt.registerTask("package-dev", ["exec:package_dev"]);
    grunt.registerTask("package-release", ["exec:package_release"]);
    grunt.registerTask("package-release-test", ["exec:package_release_test"]);

    // Custom publish task with interactive PAT input if not set in env
    grunt.registerTask('publish-dev', 'Publish Azure DevOps extension', function () {
        const done = this.async();
        const exec = require('child_process').exec;

        // Helper to run the command
        const runPublish = (token) => {
            const cmd = [
                'tfx extension publish',
                '--service-url https://marketplace.visualstudio.com',
                '--manifests vss-extension.json',
                '--overrides-file configs/dev.json',
                '--output-path ../dist',
                `--token ${token}`
            ].join(' ');

            grunt.log.writeln('🚀 Publishing extension...');
            exec(cmd, (err, stdout, stderr) => {
                if (err) {
                    grunt.log.error(stderr || err);
                    done(false);
                } else {
                    grunt.log.ok(stdout);
                    done();
                }
            });
        };

        // Check for existing token
        let token = process.env.TFS_PERSONAL_ACCESS_TOKEN;

        if (token) {
            runPublish(token);
            return;
        }

        // No token in env → prompt user interactively
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question('Enter your Personal Access Token (PAT): ', (inputToken) => {
            rl.close();
            token = inputToken.trim();

            if (!token) {
                grunt.fail.warn('❌ No token entered. Aborting.');
                return done(false);
            }

            // Ask to save token to .env for future runs
            rl.pause();
            const saveEnv = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            saveEnv.question('💾 Save token to .env for future runs? (y/n): ', (answer) => {
                if (answer.trim().toLowerCase() === 'y') {
                    fs.appendFileSync('.env', `\nTFS_PERSONAL_ACCESS_TOKEN=${token}\n`);
                    grunt.log.ok('Token saved to .env.');
                }
                saveEnv.close();
                runPublish(token);
            });
        });
    });
};