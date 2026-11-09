use super::{arg, err, Ctx, Reply};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::Emitter;
use tokio::sync::oneshot;

static ACTIVE: LazyLock<Mutex<HashMap<String, Option<oneshot::Sender<()>>>>> =
    LazyLock::new(Mutex::default);
fn endpoint(base: &str, path: &str) -> String {
    format!("{}/{path}", base.trim().trim_end_matches('/'))
}

pub(super) fn models(a: &Value) -> Reply {
    let response = reqwest::blocking::Client::new()
        .get(endpoint(arg(a, "baseUrl")?, "models"))
        .bearer_auth(arg(a, "key")?)
        .timeout(Duration::from_secs(40))
        .send()
        .map_err(err)?;
    if !response.status().is_success() {
        return Err(format!(
            "HTTP {} {}",
            response.status(),
            response.text().map_err(err)?
        ));
    }
    let body: Value = response.json().map_err(err)?;
    let models = body["data"].as_array().ok_or("接口未返回模型列表")?;
    Ok(json!(models
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect::<Vec<_>>()))
}
pub(super) fn abort(id: &str) -> Reply {
    if let Some(tx) = ACTIVE
        .lock()
        .map_err(err)?
        .get_mut(id)
        .and_then(Option::take)
    {
        let _ = tx.send(());
    }
    Ok(Value::Null)
}
pub(super) fn stream(a: &Value, ctx: &Ctx, app: &tauri::AppHandle) -> Reply {
    let id = arg(a, "reqId")?;
    relay(a, ctx, |kind, text| {
        app.emit("api-stream", json!({"id":id,"kind":kind,"text":text}))
            .map_err(err)
    })
}
fn relay(a: &Value, ctx: &Ctx, emit: impl Fn(&str, &str) -> Result<(), String>) -> Reply {
    let id = arg(a, "reqId")?;
    let list = ctx.read("apis", json!([]))?;
    let provider = list
        .as_array()
        .and_then(|v| v.iter().find(|p| p["id"] == a["provider"]))
        .ok_or("找不到 API 配置")?;
    let mut body = a["body"].clone();
    if !body.is_object() {
        return Err("请求体必须为对象".into());
    }
    body["model"] = a["model"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(Value::from)
        .unwrap_or_else(|| provider["model"].clone());
    body["stream"] = json!(true);
    let url = endpoint(arg(provider, "base_url")?, "chat/completions");
    let key = arg(provider, "key")?;
    let (tx, rx) = oneshot::channel();
    {
        let mut active = ACTIVE.lock().map_err(err)?;
        if active.contains_key(id) {
            return Err("请求编号重复".into());
        }
        active.insert(id.into(), Some(tx));
    }
    let outcome = tauri::async_runtime::block_on(async {
        let request = async {
            let mut response = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .build()
                .map_err(err)?
                .post(url)
                .bearer_auth(key)
                .json(&body)
                .send()
                .await
                .map_err(err)?;
            if !response.status().is_success() {
                return Err(format!(
                    "HTTP {} {}",
                    response.status(),
                    response.text().await.map_err(err)?
                ));
            }
            // reqwest chunks can end in the middle of a UTF-8 character.
            let mut pending = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(err)? {
                pending.extend_from_slice(&chunk);
                let read = match std::str::from_utf8(&pending) {
                    Ok(s) => s.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(e) => return Err(e.to_string()),
                };
                if read > 0 {
                    emit("data", std::str::from_utf8(&pending[..read]).map_err(err)?)?;
                    pending.drain(..read);
                }
            }
            if !pending.is_empty() {
                return Err("接口返回不完整的 UTF-8 字符".into());
            }
            Ok(())
        };
        tokio::select! { result=request=>result,_=rx=>Err("请求已取消".into()) }
    });
    ACTIVE.lock().map_err(err)?.remove(id);
    match outcome {
        Ok(()) => emit("end", "")?,
        Err(e) => emit("error", &e)?,
    };
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::Mutex,
        thread,
    };

    #[test]
    fn relay_keeps_utf8_split_across_http_chunks() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(root.path().to_owned()).unwrap();
        let base = format!("http://{}/v1", server.local_addr().unwrap());
        ctx.write(
            "apis",
            &json!([{"id":"p","key":"sample","base_url":base,"model":"default"}]),
        )
        .unwrap();
        let worker = thread::spawn(move || {
            let (mut conn, _) = server.accept().unwrap();
            let mut req = BufReader::new(&conn);
            let mut line = String::new();
            req.read_line(&mut line).unwrap();
            assert!(line.starts_with("POST /v1/chat/completions "));
            let mut length = 0;
            loop {
                line.clear();
                req.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(s) = line.to_lowercase().strip_prefix("content-length:") {
                    length = s.trim().parse().unwrap();
                }
            }
            let mut bytes = vec![0; length];
            req.read_exact(&mut bytes).unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["model"], "default");
            assert_eq!(body["stream"], true);
            conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            for part in [b"data: \xe5".as_slice(), b"\xa5\xbd\n\n".as_slice()] {
                write!(conn, "{:x}\r\n", part.len()).unwrap();
                conn.write_all(part).unwrap();
                conn.write_all(b"\r\n").unwrap();
                conn.flush().unwrap();
                thread::sleep(Duration::from_millis(20));
            }
            conn.write_all(b"0\r\n\r\n").unwrap();
        });
        let events = Mutex::new(Vec::new());
        relay(
            &json!({"reqId":"test-utf8","provider":"p","body":{"messages":[]},"model":""}),
            &ctx,
            |k, t| {
                events.lock().unwrap().push((k.to_owned(), t.to_owned()));
                Ok(())
            },
        )
        .unwrap();
        worker.join().unwrap();
        let events = events.into_inner().unwrap();
        assert_eq!(events.last().unwrap().0, "end");
        let data = events
            .iter()
            .filter(|(k, _)| k == "data")
            .map(|(_, s)| s.as_str())
            .collect::<String>();
        assert_eq!(data, "data: 好\n\n");
    }
    #[test]
    fn abort_interrupts_request_waiting_for_headers() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(dir.path().to_owned()).unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        ctx.write(
            "apis",
            &json!([{"id":"p","key":"sample","base_url":base,"model":"m"}]),
        )
        .unwrap();
        let worker = thread::spawn(move || {
            let events = Mutex::new(Vec::new());
            relay(
                &json!({"reqId":"test-abort","provider":"p","body":{}}),
                &ctx,
                |kind, text| {
                    events
                        .lock()
                        .unwrap()
                        .push((kind.to_owned(), text.to_owned()));
                    Ok(())
                },
            )
            .unwrap();
            events.into_inner().unwrap()
        });
        let (mut conn, _) = server.accept().unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut buf = [0; 128];
        assert!(conn.read(&mut buf).unwrap() > 0);
        abort("test-abort").unwrap();
        assert_eq!(
            worker.join().unwrap(),
            vec![("error".into(), "请求已取消".into())]
        );
    }
}
