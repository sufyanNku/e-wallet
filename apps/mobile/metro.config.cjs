/* global require, module, __dirname */
// Expo's Metro loader expects a CommonJS configuration.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
module.exports = config;
