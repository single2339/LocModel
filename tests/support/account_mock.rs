// This fixture never connects to the network. The desktop's account_base is set
// before startup, so device registration, checkout and activation stay on loopback.
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Response, Server};

pub fn start() -> String {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    let origin = base.clone();
    std::thread::spawn(move || {
        let mut polls = 0;
        let mut active = false;
        let mut orders = 0;
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86400;
        for mut req in server.incoming_requests() {
            let req_url = req.url().to_owned();
            let url = reqwest::Url::parse(&format!("{origin}{req_url}")).unwrap();
            let act = url
                .query_pairs()
                .find(|(k, _)| k == "act")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            let value: Value = match act.as_str() {
                "ping" => json!({"ok":true}),
                "client_config" => {
                    json!({"ok":true,"nodes":[],"hf_mirror":"off","update":{"version":"3.1.1","notes":"Desktop integration fixture","win":format!("{origin}/release.exe"),"mac":format!("{origin}/release.dmg"),"linux":format!("{origin}/release.tar.gz"),"page":origin,"force_below":""}})
                }
                "plans" => {
                    json!({"plans":[{"id":"fixture","name":"测试套餐","price":"1.00","days":1,"tip":""}],"methods":[{"id":"alipay","name":"测试扫码"}]})
                }
                "create" if body.contains("fixture") && body.contains("alipay") && orders == 0 => {
                    orders += 1;
                    json!({"ok":true,"order":"fixture-order","method":"alipay","method_name":"测试扫码","plan":"测试套餐","kind":"qr","qr":"https://example.invalid/fixture","money":"1.00","currency":"CNY","expires_at":expires})
                }
                "order" if orders == 1 && req_url.contains("fixture-order") => {
                    polls += 1;
                    if polls < 2 {
                        json!({"ok":true,"status":"pending"})
                    } else {
                        active = true;
                        json!({"ok":true,"status":"paid","token":"fixture-order-token","expires":expires})
                    }
                }
                "recover" if body.contains("example") => json!({"ok":true,"msg":"恢复邮件已受理"}),
                "activate" if body.contains("FIXTURE-CODE") => {
                    active = true;
                    json!({"ok":true,"token":"fixture-activation-token","expires":expires})
                }
                "info" if active => json!({"ok":true,"valid":true,"member":true,"expires":expires}),
                "status" => {
                    json!({"ok":true,"member":active,"expires":if active {expires}else{0},"token":if active {"fixture-order-token"}else{""}})
                }
                _ => json!({"ok":false,"error":"测试服务拒绝了请求"}),
            };
            let _ = req.respond(Response::from_string(value.to_string()).with_header(
                Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap(),
            ));
        }
    });
    base
}
