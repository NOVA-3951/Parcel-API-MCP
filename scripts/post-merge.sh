#!/bin/bash
set -e

# Install any new dependencies and rebuild the TypeScript output.
npm install
npm run build
