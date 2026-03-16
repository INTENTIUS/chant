use zed_extension_api::{self as zed, Command, LanguageServerId, Result, Worktree};

struct ChantExtension;

impl zed::Extension for ChantExtension {
    fn new() -> Self {
        ChantExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        // Verify this is a chant project
        let has_config = worktree
            .read_text_file("chant.config.ts")
            .is_ok()
            || worktree.read_text_file("chant.config.json").is_ok();

        if !has_config {
            return Err("Not a chant project (no chant.config.ts or chant.config.json)".into());
        }

        // Find the chant binary
        let binary = worktree
            .which("chant")
            .ok_or("chant CLI not found on PATH")?;

        Ok(Command {
            command: binary,
            args: vec!["serve".into(), "lsp".into()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(ChantExtension);
