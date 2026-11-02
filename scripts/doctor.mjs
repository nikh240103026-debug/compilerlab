#!/usr/bin/env node
// @ts-check
import { runDoctor } from './lib/doctor.mjs';

process.exitCode = await runDoctor();
