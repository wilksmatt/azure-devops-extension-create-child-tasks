/*
 * Webpack configuration for Azure DevOps extension (AMD compatible)
 *
 * Notes:
 * - This builds your entry as an AMD module so it can still be loaded by VSS.require(["scripts/app"]).
 * - All Azure DevOps SDK modules (VSS/*, TFS/*) and q are marked as externals so they are not bundled.
 * - This file lives in `src/` because your package.json is in `src/`.
 * - This does NOT change your current build; wire it in via npm scripts when you’re ready.
 */

const { resolve: _resolve } = require('path');

/** @type {import('webpack').Configuration | import('webpack').ConfigurationFactory} */
module.exports = (env, argv) => {

    // Determine mode
    const mode = (argv && argv.mode) || process.env.NODE_ENV || 'development';
    const isProd = mode === 'production';

  const config = {
    mode,
    target: 'web',

    // Keep the same module id as today (scripts/app) so VSS.require can still resolve it if you replace the file
    entry: {
      'scripts/app': _resolve(__dirname, 'scripts/app.js'),
    },

    output: {
      // Output to an isolated folder to avoid overwriting existing sources by default
      path: _resolve(__dirname, 'bundled'),
      filename: '[name].bundle.js', // => bundled/scripts/app.bundle.js
      // Webpack 5: use library to emit an AMD module with a name
      library: {
        type: 'amd',
        name: 'scripts/app',
      },
      clean: true,
    },

    devtool: isProd ? 'source-map' : 'eval-source-map',

    // Don’t bundle ADO/VSS SDK modules or q; they’re provided at runtime by Azure DevOps
    externals: [
      ({ request }, callback) => {
        if (/^(VSS|TFS)\//.test(request) || request === 'q') {
          // Tell webpack this dependency should be resolved at runtime by AMD loader
          return callback(null, 'amd ' + request);
        }
        callback();
      },
    ],

    module: {
      rules: [
        // If you add modern JS, you can enable Babel here
        // {
        //   test: /\.m?js$/,
        //   exclude: /(node_modules|bower_components)/,
        //   use: {
        //     loader: 'babel-loader',
        //     options: { presets: ['@babel/preset-env'] },
        //   },
        // },
      ],
    },

    resolve: {
      extensions: ['.js'],
    },

    optimization: {
      splitChunks: false,
      runtimeChunk: false,
      minimize: isProd,
    },

    // Quieter output by default; adjust as needed
    stats: 'minimal',
  };

  // Only enable devServer during development (`webpack serve`)
  if (!isProd) {
    config.devServer = {
      host: 'localhost',
      port: 3000,
      https: true, // use a self-signed cert by default; you can provide custom certs if needed
      static: {
        directory: _resolve(__dirname), // serve HTML and assets from src
        watch: true,
      },
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
      },
      client: {
        overlay: false, // overlay inside an iframe isn’t helpful
      },
      hot: false, // HMR inside ADO iframe is often unreliable
      liveReload: true,
      allowedHosts: 'all',
    };
  }

  return config;
};
