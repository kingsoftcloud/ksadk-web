import { defineConfig } from '@playwright/test';
import local from './playwright.local-heavy-history.config.mjs';

export default defineConfig({ ...local, testMatch: 'released-runtime-history.spec.ts' });
