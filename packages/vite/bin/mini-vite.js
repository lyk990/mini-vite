#!/usr/bin/env node
import { performance } from 'node:perf_hooks'

global.__vite_start_time = performance.now()
import("../dist/node/cli.js");
