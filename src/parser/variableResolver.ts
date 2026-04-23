import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Variable, VariableSource } from './types';

const FILE_VAR_PATTERN = /^@([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/;
const PLACEHOLDER_PATTERN = /\{\{([^}]+)\}\}/g;

/**
 * Parse `@var = value` lines from the top of an .http file.
 * Stops at the first request line (HTTP method) or request separator (`###`).
 */
export function parseFileVariables(fileText: string): Variable[] {
  const variables: Variable[] = [];
  const lines = fileText.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      // Only treat as separator if it's exactly ### (not #### or more)
      if (/^###(?!#)/.test(trimmed)) {
        break;
      }
      continue;
    }

    const match = trimmed.match(FILE_VAR_PATTERN);
    if (match) {
      variables.push({
        name: match[1],
        value: match[2],
        source: 'file',
      });
    } else {
      // First non-variable, non-comment line means we've left the variable section
      break;
    }
  }

  return variables;
}

/**
 * Read environment-specific variables from the `destinationAnywhere.environmentVariables`
 * VS Code setting, filtered by the `destinationAnywhere.activeEnvironment` setting.
 */
export function getSettingsVariables(): Variable[] {
  const config = vscode.workspace.getConfiguration('destinationAnywhere');
  const activeEnv = config.get<string>('activeEnvironment');
  if (!activeEnv) {
    return [];
  }

  const envVars = config.get<Record<string, Record<string, string>>>('environmentVariables');
  if (!envVars) {
    return [];
  }

  const envBlock = envVars[activeEnv];
  if (!envBlock) {
    return [];
  }

  return Object.entries(envBlock).map(([name, value]) => ({
    name,
    value: String(value),
    source: 'settings' as VariableSource,
  }));
}

/**
 * Parse a dotenv file into variables. Lines starting with `#` are comments.
 * Format: `KEY=VALUE` — the value is everything after the first `=`.
 * Missing files are silently ignored.
 */
export async function parseDotenvFile(
  filePath: string,
  source: VariableSource = 'dotenv',
): Promise<Variable[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const variables: Variable[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (key) {
      variables.push({ name: key, value, source });
    }
  }

  return variables;
}

/**
 * Collect all variables from every source, respecting resolution order:
 *   1. VS Code settings (lowest priority)
 *   2. `.env` file
 *   3. `.env.{activeEnv}` file
 *   4. File-level `@var = value` definitions (highest priority)
 */
export async function collectVariables(
  fileText: string,
  workspaceFolder: string | undefined,
): Promise<Map<string, string>> {
  const variables = new Map<string, string>();

  // 1. Settings variables (lowest priority)
  for (const v of getSettingsVariables()) {
    variables.set(v.name, v.value);
  }

  // 2 & 3. Dotenv files
  if (workspaceFolder) {
    const baseDotenv = path.join(workspaceFolder, '.env');
    for (const v of await parseDotenvFile(baseDotenv)) {
      variables.set(v.name, v.value);
    }

    const activeEnv = vscode.workspace
      .getConfiguration('destinationAnywhere')
      .get<string>('activeEnvironment');

    if (activeEnv) {
      const envDotenv = path.join(workspaceFolder, `.env.${activeEnv}`);
      for (const v of await parseDotenvFile(envDotenv)) {
        variables.set(v.name, v.value);
      }
    }
  }

  // 4. File-level variables (highest priority)
  for (const v of parseFileVariables(fileText)) {
    variables.set(v.name, v.value);
  }

  return variables;
}

/**
 * Replace all `{{variableName}}` placeholders in `text` with their values.
 * Throws if a referenced variable is not defined.
 */
export function resolveVariables(text: string, variables: Map<string, string>): string {
  return text.replace(PLACEHOLDER_PATTERN, (_match, varName: string) => {
    const trimmed = varName.trim();
    const value = variables.get(trimmed);
    if (value === undefined) {
      throw new Error(`Undefined variable: {{${trimmed}}}`);
    }
    return value;
  });
}
