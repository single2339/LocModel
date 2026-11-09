mod api;
mod computer;
mod files;
mod web;
mod workspace;
pub use workspace::shutdown;

use crate::{Ctx, Reply};
use serde_json::{json, Value};
use std::path::Path;

fn arg<'a>(a: &'a Value, key: &str) -> Result<&'a str, String> {
    a[key].as_str().ok_or_else(|| format!("缺少参数 {key}"))
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &tauri::AppHandle) -> Option<Reply> {
    (|| -> Result<Option<Value>, String> {
        Ok(Some(match cmd {
            "agent_pick_folder" => Ok(json!(rfd::FileDialog::new().pick_folder())),
            "agent_resolve" => workspace::resolve(a),
            "agent_tool" => workspace::run(Path::new(arg(a, "ws")?), arg(a, "name")?, &a["args"]),
            "tool_read_file" => Ok(json!(files::document(Path::new(arg(a, "path")?))?)),
            "tool_list_dir" | "tool_write_file" | "tool_run_command" => {
                let cwd = std::env::current_dir().map_err(err)?;
                let name = match cmd {
                    "tool_list_dir" => "list_files",
                    "tool_write_file" => "write_file",
                    _ => "run_command",
                };
                let mut args = a.clone();
                if name == "list_files" {
                    args["depth"] = json!(1);
                }
                workspace::run(&cwd, name, &args)
            }
            "tool_web_fetch" => web::fetch(arg(a, "url")?),
            "tool_web_search" => web::search(arg(a, "query")?),
            "load_attachments" | "pick_attachments" => files::attachments(cmd, a),
            "save_image_file" | "save_text_file" => files::save(cmd, a),
            "computer_screenshot" => computer::shot(),
            "computer_action" => computer::act(&a["action"]),
            "api_save" => {
                if !a["list"].is_array() {
                    return Err("API 配置必须为列表".into());
                }
                ctx.write("apis", &a["list"])?;
                Ok(Value::Null)
            }
            "api_list" => ctx.read("apis", json!([])),
            "api_models" => api::models(a),
            "api_stream" => api::stream(a, ctx, app),
            "api_abort" => api::abort(arg(a, "reqId")?),
            _ => return Ok(None),
        }?))
    })()
    .transpose()
}
