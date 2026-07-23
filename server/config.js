const REQUIRED_SETTINGS = ['OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'DATABASE_PATH'];

export function validateConfig(env = process.env) {
  const errors = REQUIRED_SETTINGS.filter((name) => !env[name] || env[name].trim() === '').map(
    (name) => `${name} is required`
  );

  if (errors.length > 0) {
    throw new Error(`Invalid ChatBDG configuration:\n- ${errors.join('\n- ')}`);
  }
}
