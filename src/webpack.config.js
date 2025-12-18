/*
 * Webpack configuration for Azure DevOps extension (modern SDK bundle)
 *
 * Notes:
 * - The entry point lives under `scripts/app.ts` and is compiled with TypeScript.
 * - Output lands in `dist/` so the manifest can reference already-bundled assets.
 * - All dependencies (including the Azure DevOps SDK/API) are bundled for simplicity.
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

    entry: {
      'scripts/app': _resolve(__dirname, 'scripts/app.ts'),
    },

    output: {
      path: _resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },

    // Azure DevOps iframes block eval(), so stick to non-eval source maps even in dev
    devtool: 'source-map',

    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: 'ts-loader',
        },
      ],
    },

    resolve: {
      extensions: ['.ts', '.tsx', '.js'],
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
        directory: _resolve(__dirname),
        watch: true,
      },
      devMiddleware: {
        writeToDisk: true,
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
