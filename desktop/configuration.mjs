import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

class ConfigurationError extends Error {}

function object(value, path) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationError(`${path} must be an object`);
  }
  return value;
}

function append(value, name, path, toolName = false) {
  if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))) {
    throw new ConfigurationError(`${path} must be an array of non-empty strings`);
  }
  const result = [...value ?? []];
  if (!result.some(item => (toolName ? item.trim().toLowerCase() : item) === name)) result.push(name);
  return result;
}

export function buildPersistentDesktopPatch(config) {
  if (config === undefined) throw new ConfigurationError('configuration must be an object');
  object(config, 'configuration');
  const tools = object(config.tools, 'tools');
  const plugins = object(config.plugins, 'plugins');
  const pluginEntries = object(plugins.entries, 'plugins.entries');
  const pluginAllow = plugins.allow === undefined ? undefined : append(plugins.allow, 'cua-computer', 'plugins.allow');
  object(pluginEntries['cua-computer'], 'plugins.entries.cua-computer');
  const agents = object(config.agents, 'agents');
  if (agents.list !== undefined) {
    throw new ConfigurationError('Migrate the legacy roster to agents.entries before preparing this patch');
  }
  const entries = object(agents.entries, 'agents.entries');
  const patch = {
    desktop: { host: {
      enabled: true, managed: false, port: 5900,
      passwordFile: '/run/openclaw-desktop/vnc-password.txt',
    } },
    plugins: {
      // An empty allowlist means unrestricted plugin loading, not deny-all.
      ...plugins.allow?.length ? { allow: pluginAllow } : {},
      entries: { 'cua-computer': { enabled: true } },
    },
    tools: { alsoAllow: append(tools.alsoAllow, 'computer', 'tools.alsoAllow', true) },
  };
  const restricted = {};
  for (const [id, value] of Object.entries(entries)) {
    if (!['noclegi', 'samorzad'].includes(id.trim().toLowerCase())) continue;
    const agent = object(value, `agents.entries.${id}`);
    const agentTools = object(agent.tools, `agents.entries.${id}.tools`);
    restricted[id] = { tools: { deny: append(agentTools.deny, 'computer', `agents.entries.${id}.tools.deny`, true) } };
  }
  if (Object.keys(restricted).length) patch.agents = { entries: restricted };
  return patch;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) {
      throw new ConfigurationError('Usage: node configuration.mjs <config.json5>; prints a merge patch only, never writes configuration');
    }
    const { default: JSON5 } = await import('json5');
    const config = JSON5.parse(await readFile(process.argv[2], 'utf8'));
    console.error('Merge patch only: apply through the configuration editor/API; do not overwrite the configuration file.');
    console.log(JSON.stringify(buildPersistentDesktopPatch(config), null, 2));
  } catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : 'Cannot read or parse the configuration; no patch was produced');
    process.exitCode = 1;
  }
}
