use super::*;
use std::thread;
use tiny_http::{Method, Response, Server};

#[test]
fn wire_contract_and_entitlements() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::new(dir.path().into()).unwrap();
    let server = Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr());
    ctx.write("settings", &json!({"account_base":base}))
        .unwrap();
    let initial = status(&ctx).unwrap();
    let id = initial["device_id"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    let expires = now().as_secs() + 600;
    let node = "https://downloads.example.invalid";
    let requests = vec![
        (format!("status&device={id}"), None, json!({"member":false})),
        ("plans".into(), None, json!({"plans":[],"methods":[]})),
        (
            "client_config".into(),
            None,
            json!({"ok":true,"nodes":[{"url":node,"name":"test"}]}),
        ),
        (
            "create".into(),
            Some(
                json!({"device":id,"plan":"month","method":"wxpay","email":"buyer@example.invalid"}),
            ),
            json!({"ok":true,"order":"A+B","kind":"qr","qr":"fixture"}),
        ),
        (
            format!("order&order=A%2BB&device={id}"),
            None,
            json!({"status":"pending","token":"bogus","expires":expires}),
        ),
        (
            "activate".into(),
            Some(json!({"device":id,"code":"bad"})),
            json!({"ok":false,"error":"invalid","token":"bogus","expires":expires}),
        ),
        (
            format!("order&order=A%2BB&device={id}"),
            None,
            json!({"status":"paid","expires":expires}),
        ),
        (
            format!("order&order=A%2BB&device={id}"),
            None,
            json!({"status":"paid","token":"order+token","expires":expires}),
        ),
        (
            "info&token=order%2Btoken".into(),
            None,
            json!({"ok":true,"expires":expires}),
        ),
        (
            "activate".into(),
            Some(json!({"device":id,"code":"good"})),
            json!({"ok":true,"token":"activated","expires":expires}),
        ),
        (
            "recover".into(),
            Some(json!({"email":"buyer@example.invalid"})),
            json!({"ok":true,"msg":"已受理"}),
        ),
        (
            "info&token=activated".into(),
            None,
            json!({"ok":false,"error":"revoked"}),
        ),
        (
            format!("status&device={id}"),
            None,
            json!({"member":true,"token":"restored","expires":expires}),
        ),
        (
            "info&token=restored".into(),
            None,
            json!({"ok":true,"expires":1}),
        ),
    ];
    let worker = thread::spawn(move || {
        for (query, body, response) in requests {
            let mut req = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .expect("expected a request");
            assert_eq!(req.url(), format!("/api.php?act={query}"));
            if let Some(body) = body {
                assert_eq!(req.method(), &Method::Post);
                assert!(req.headers().iter().any(
                    |h| h.field.equiv("Content-Type") && h.value.as_str() == "application/json"
                ));
                let incoming: Value = serde_json::from_reader(req.as_reader()).unwrap();
                assert_eq!(incoming, body);
            } else {
                assert_eq!(req.method(), &Method::Get);
            }
            req.respond(Response::from_string(response.to_string()))
                .unwrap();
        }
    });
    assert_eq!(restore(&ctx).unwrap()["member"], false);
    assert!(run("accel_plans", &Value::Null, &ctx).unwrap()["plans"].is_array());
    client_config(&ctx).unwrap();
    let state = status(&ctx).unwrap();
    assert_eq!(state["trusted_lines"], json!([node]));
    let create = run(
        "accel_create",
        &json!({"plan":"month","method":"wxpay","email":"buyer@example.invalid"}),
        &ctx,
    )
    .unwrap();
    assert_eq!(create["qr"], "fixture");
    let order = json!({"order":"A+B"});
    assert_eq!(
        run("accel_order", &order, &ctx).unwrap()["status"],
        "pending"
    );
    assert!(run("activate_code", &json!({"code":"bad"}), &ctx).is_err());
    assert!(run("accel_order", &order, &ctx).is_err());
    assert_eq!(status(&ctx).unwrap()["member"], false);
    assert_eq!(
        run("accel_order", &order, &ctx).unwrap()["accel"]["member"],
        true
    );
    let restarted = Ctx::new(dir.path().into()).unwrap();
    assert_eq!(status(&restarted).unwrap()["token"], "order+token");
    assert_eq!(restore(&restarted).unwrap()["member"], true);
    let stale = Account::load(&ctx).unwrap();
    assert_eq!(
        run("activate_code", &json!({"code":"good"}), &ctx).unwrap()["token"],
        "activated"
    );
    assert_eq!(stale.grant("", 0, true).unwrap()["token"], "activated");
    assert_eq!(
        run(
            "accel_recover",
            &json!({"email":"buyer@example.invalid"}),
            &ctx
        )
        .unwrap(),
        "已受理"
    );
    assert_eq!(restore(&ctx).unwrap()["member"], false);
    assert_eq!(restore(&ctx).unwrap()["token"], "restored");
    assert_eq!(restore(&ctx).unwrap()["member"], false);
    worker.join().unwrap();
}

#[test]
fn identities_caches_and_fallbacks_are_scoped_to_issuer() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::new(dir.path().into()).unwrap();
    let legacy = "0123456789abcdef0123456789abcdef";
    ctx.write(
        "settings",
        &json!({"device_id":legacy,"member_token":"unvalidated","member_expires":4102444800u64}),
    )
    .unwrap();
    let account = Account::load(&ctx).unwrap();
    assert_eq!(account.device(), legacy);
    assert_eq!(account.view(&account.data)["member"], false);
    assert_eq!(account.bases(), BASES);
    assert!(account.accept(&json!({"token":"bogus"}), false).is_err());
    let lifetime = account
        .accept(&json!({"token":"server-lifetime","expires":0}), false)
        .unwrap();
    assert_eq!(lifetime["member"], true);
    account.grant("", 0, false).unwrap();
    run("account_ok", &json!({"base":BASES[2]}), &ctx).unwrap();
    assert_eq!(Account::load(&ctx).unwrap().bases()[0], BASES[2]);
    ctx.write("settings",&json!({"account_base":"http://127.0.0.1:1","device_id":legacy,"member_token":"unvalidated"})).unwrap();
    let custom = Account::load(&ctx).unwrap();
    assert_ne!(custom.device(), legacy);
    assert!(custom.data["legacy_token"].is_null());
    assert_eq!(custom.bases(), ["http://127.0.0.1:1"]);
    custom.grant("custom", 4102444800, false).unwrap();
    assert!(restore(&ctx).is_err());
    assert_eq!(status(&ctx).unwrap()["token"], "custom");
    ctx.write("settings", &json!({})).unwrap();
    assert_eq!(status(&ctx).unwrap()["token"], "");
    ctx.write(
        "settings",
        &json!({"account_base":"http://example.invalid"}),
    )
    .unwrap();
    assert!(Account::load(&ctx).is_err());
}
