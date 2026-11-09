use crate::{Ctx, Reply};
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde_json::{json, Value};
use std::hash::{BuildHasher, Hash, Hasher, RandomState};
use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const BASES: [&str; 3] = [
    "https://activation.locmodel.com",
    "https://get.locmodel.com",
    "https://locmodel.actcb.com",
];
const LINES: [&str; 2] = ["https://m1.locmodel.com", "https://m2.locmodel.com"];

fn now() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

fn current_expiry(expires: u64) -> bool {
    expires == 0 || expires > now().as_secs()
}

fn new_device() -> String {
    let mut id = String::with_capacity(32);
    for n in 0..2u64 {
        let mut hash = RandomState::new().build_hasher();
        n.hash(&mut hash);
        now().as_nanos().hash(&mut hash);
        id.push_str(&format!("{:016x}", hash.finish()));
    }
    id
}

fn base_url(s: &str) -> Result<String, String> {
    let u = Url::parse(s.trim()).map_err(|_| "账号地址无效")?;
    if !matches!(u.scheme(), "https" | "http")
        || u.host().is_none()
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err("账号地址无效".into());
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}

fn account_base(raw: &str) -> Result<String, String> {
    let base = raw.trim();
    let base = if base.is_empty() {
        BASES[0].into()
    } else {
        base_url(base)?
    };
    let parsed = Url::parse(&base).map_err(|_| "账号地址无效")?;
    if parsed.scheme() == "http"
        && !matches!(parsed.host_str(), Some("localhost"))
        && !parsed.host_str().is_some_and(|h| {
            h.trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
        })
    {
        return Err("远程账号中心必须使用 HTTPS".into());
    }
    Ok(base)
}
pub fn validate_base(s: &str) -> Result<(), String> {
    account_base(s).map(|_| ())
}

struct Account<'a> {
    ctx: &'a Ctx,
    key: String,
    data: Value,
}

impl<'a> Account<'a> {
    fn load(ctx: &'a Ctx) -> Result<Self, String> {
        let s = ctx.settings()?;
        Self::from_settings(ctx, &s)
    }

    fn from_settings(ctx: &'a Ctx, s: &Value) -> Result<Self, String> {
        let base = account_base(s["account_base"].as_str().unwrap_or(""))?;
        let official = BASES.contains(&base.as_str());
        let key = if official { BASES[0].into() } else { base };
        let all = ctx.read("account", json!({}))?;
        let data = if all[&key].is_object() {
            all[&key].clone()
        } else {
            let all = ctx.update("account", json!({}), |all| {
                if all[&key].is_null() {
                    let migrate = official && all.as_object().is_some_and(|map| map.is_empty());
                    let id = s["device_id"]
                        .as_str()
                        .filter(|id| {
                            migrate && id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
                        })
                        .map(str::to_owned)
                        .unwrap_or_else(new_device);
                    all[&key] = json!({"device_id": id});
                    if migrate {
                        // A migrated token becomes usable only after the issuer confirms it.
                        all[&key]["legacy_token"] = s["member_token"].clone();
                        all[&key]["buy_email"] = s["buy_email"].clone();
                        all[&key]["preferred"] = s["preferred_line"].clone();
                        all[&key]["preferred_ip"] = s["preferred_ip"].clone();
                        all[&key]["nodes"] = s["accel_nodes"].clone();
                        all[&key]["lines"] = s["accel_lines"].clone();
                    }
                }
                Ok(())
            })?;
            all[&key].clone()
        };
        Ok(Self { ctx, key, data })
    }

    fn update(&self, f: impl FnOnce(&mut Value) -> Result<(), String>) -> Reply {
        let all = self
            .ctx
            .update("account", json!({}), |all| f(&mut all[&self.key]))?;
        Ok(all[&self.key].clone())
    }

    fn bases(&self) -> Vec<&str> {
        if self.key != BASES[0] {
            return vec![self.key.as_str()];
        }
        let mut bases = BASES.to_vec();
        if let Some(i) = bases
            .iter()
            .position(|b| Some(*b) == self.data["active_base"].as_str())
        {
            let active = bases.remove(i);
            bases.insert(0, active);
        }
        bases
    }

    fn request(&self, act: &str, query: &[(&str, &str)], body: Option<Value>) -> Reply {
        let client = Client::builder()
            .user_agent("LocModel/0.1")
            .timeout(Duration::from_secs(8))
            .redirect(Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let mut last = String::from("账号中心无法连接");
        for base in self.bases() {
            let mut url = Url::parse(&format!("{base}/api.php")).map_err(|_| "账号地址无效")?;
            url.query_pairs_mut()
                .append_pair("act", act)
                .extend_pairs(query.iter().copied());
            let req = match &body {
                Some(b) => client.post(url).json(b),
                None => client.get(url),
            };
            let resp = match req.send() {
                Ok(r) => r,
                Err(e) => {
                    last = format!("账号中心无法连接（{base}）");
                    if body.is_some() && !e.is_connect() {
                        return Err(format!("{last}，无法确认请求结果"));
                    }
                    continue;
                }
            };
            let status = resp.status();
            if status.is_server_error() && body.is_none() {
                last = format!("账号中心返回 HTTP {status}");
                continue;
            }
            let value = match resp.json::<Value>() {
                Ok(v) if v.is_object() => v,
                _ if body.is_none() && status.is_success() => {
                    last = "账号中心返回无效数据".into();
                    continue;
                }
                _ => return Err(format!("账号中心返回无效数据（HTTP {status}）")),
            };
            if act == "info" && matches!(status.as_u16(), 401 | 403) && value["ok"] == false {
                return Ok(value);
            }
            if !status.is_success() {
                return Err(value["error"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("账号中心返回 HTTP {status}")));
            }
            if self.data["active_base"].as_str() != Some(base) {
                let _ = self.update(|s| {
                    s["active_base"] = json!(base);
                    Ok(())
                });
            }
            return Ok(value);
        }
        Err(last)
    }

    fn device(&self) -> &str {
        self.data["device_id"].as_str().unwrap_or("")
    }

    fn view(&self, data: &Value) -> Value {
        let expires = data["expires"].as_u64().unwrap_or(0);
        let token = data["token"].as_str().unwrap_or("");
        let member = !token.is_empty() && data["expires"].as_u64().is_some_and(current_expiry);
        let lines = data["lines"]
            .as_array()
            .filter(|l| !l.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                if self.key == BASES[0] {
                    LINES.iter().map(|u| json!(u)).collect()
                } else {
                    vec![]
                }
            });
        let nodes = data["nodes"]
            .as_array()
            .filter(|n| !n.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                lines
                    .iter()
                    .enumerate()
                    .map(|(i, url)| json!({"url":url,"name":format!("线路{}",i+1)}))
                    .collect()
            });
        json!({"member":member,"token":if member {token} else {""},"expires":expires,"device_id":self.device(),
            "official":self.key==BASES[0],"lines":lines,"nodes":nodes,
            "preferred":data["preferred"].as_str().unwrap_or(""),"preferred_ip":data["preferred_ip"].as_str().unwrap_or(""),
            "trusted_lines":data["trusted_lines"].as_array().cloned().unwrap_or_default()})
    }

    fn grant(&self, token: &str, expires: u64, compare: bool) -> Reply {
        self.update(|s| {
            if !compare || s["revision"] == self.data["revision"] {
                s["token"] = json!(token);
                s["expires"] = json!(expires);
                s["legacy_token"] = Value::Null;
                s["revision"] = json!(s["revision"].as_u64().unwrap_or(0).saturating_add(1));
            }
            Ok(())
        })?;
        status(self.ctx)
    }

    fn accept(&self, v: &Value, compare: bool) -> Reply {
        let token = field(v, "token")?;
        let expires = v["expires"]
            .as_u64()
            .filter(|&t| current_expiry(t))
            .ok_or("账号中心未返回有效期限")?;
        self.grant(token, expires, compare)
    }

    fn restore(&self) -> Reply {
        let token = self.data["token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(self.data["legacy_token"].as_str().filter(|s| !s.is_empty()));
        if let Some(token) = token {
            let v = self.request("info", &[("token", token)], None)?;
            match v["ok"].as_bool() {
                Some(true) => {
                    if v["valid"] == false || v["member"] == false {
                        return self.grant("", 0, true);
                    }
                    let expires = v["expires"].as_u64().ok_or("账号中心未返回有效期限")?;
                    return self.grant(
                        if current_expiry(expires) { token } else { "" },
                        expires,
                        true,
                    );
                }
                Some(false) => return self.grant("", 0, true),
                None => return Err("账号中心未返回令牌状态".into()),
            }
        }
        let v = self.request("status", &[("device", self.device())], None)?;
        if v["ok"] == false {
            return Err(service_error(&v));
        }
        match v["member"].as_bool() {
            Some(true) => self.accept(&v, true),
            Some(false) => self.grant("", 0, true),
            None => Err("账号中心未返回会员状态".into()),
        }
    }
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少 {key}"))
}
fn service_error(r: &Value) -> String {
    r["error"]
        .as_str()
        .unwrap_or("账号中心拒绝了请求")
        .to_owned()
}
fn success(r: Value) -> Reply {
    if r["ok"] == true {
        Ok(r)
    } else {
        Err(service_error(&r))
    }
}

pub fn status(ctx: &Ctx) -> Reply {
    let a = Account::load(ctx)?;
    Ok(a.view(&a.data))
}
pub fn settings(ctx: &Ctx) -> Reply {
    let mut s = ctx.settings()?;
    let a = Account::from_settings(ctx, &s)?;
    let v = a.view(&a.data);
    s["device_id"] = v["device_id"].clone();
    s["member_token"] = v["token"].clone();
    s["member_expires"] = v["expires"].clone();
    s["buy_email"] = json!(a.data["buy_email"].as_str().unwrap_or(""));
    Ok(s)
}
pub fn restore(ctx: &Ctx) -> Reply {
    Account::load(ctx)?.restore()
}

fn nodes(v: &Value) -> Reply {
    let rows = v.as_array().ok_or("线路列表格式错误")?;
    let mut result = vec![];
    for n in rows {
        let Some(url) = n["url"].as_str().and_then(|s| base_url(s).ok()) else {
            continue;
        };
        if result.iter().any(|n: &Value| n["url"] == url) {
            continue;
        }
        let name = n["name"].as_str().unwrap_or("").trim();
        result.push(json!({"url":url,"name":if name.is_empty(){format!("线路{}",result.len()+1)}else{name.into()}}));
    }
    Ok(json!(result))
}
fn apply_nodes(data: &mut Value, n: &Value) {
    data["nodes"] = n.clone();
    data["lines"] = json!(n
        .as_array()
        .unwrap()
        .iter()
        .map(|r| &r["url"])
        .collect::<Vec<_>>());
}

pub fn client_config(ctx: &Ctx) -> Reply {
    let a = Account::load(ctx)?;
    let cfg = success(a.request("client_config", &[], None)?)?;
    if let Some(list) = cfg.get("nodes") {
        let n = nodes(list)?;
        a.update(|s| {
            apply_nodes(s, &n);
            s["trusted_lines"] = s["lines"].clone();
            Ok(())
        })?;
    }
    Ok(cfg)
}

fn run(cmd: &str, args: &Value, ctx: &Ctx) -> Reply {
    let a = Account::load(ctx)?;
    match cmd {
        "accel_status" => Ok(a.view(&a.data)),
        "account_bases" => Ok(json!(a.bases())),
        "account_ok" => {
            let base = base_url(field(args, "base")?)?;
            if !a.bases().contains(&base.as_str()) {
                return Err("未知账号地址".into());
            }
            a.update(|s| {
                s["active_base"] = json!(base);
                Ok(())
            })?;
            Ok(Value::Null)
        }
        "accel_plans" => {
            let r = a.request("plans", &[], None)?;
            if r["plans"].is_array() && r["methods"].is_array() && r["ok"] != false {
                Ok(r)
            } else {
                Err(service_error(&r))
            }
        }
        "accel_create" => {
            let email = args["email"].as_str().unwrap_or("").trim();
            let body = json!({"device":a.device(),"plan":field(args,"plan")?,"method":field(args,"method")?,"email":email});
            let r = success(a.request("create", &[], Some(body))?)?;
            field(&r, "order")?;
            let _ = a.update(|s| {
                s["buy_email"] = json!(email);
                Ok(())
            });
            Ok(r)
        }
        "accel_order" => {
            let mut r = a.request(
                "order",
                &[("order", field(args, "order")?), ("device", a.device())],
                None,
            )?;
            if r["ok"] == false || r["status"].as_str().is_none() {
                return Err(service_error(&r));
            }
            if r["status"] == "paid" {
                r["accel"] = a.accept(&r, false)?;
            }
            Ok(r)
        }
        "activate_code" => {
            let r = success(a.request(
                "activate",
                &[],
                Some(json!({"device":a.device(),"code":field(args,"code")?})),
            )?)?;
            a.accept(&r, false)
        }
        "accel_recover" => {
            let r =
                success(a.request("recover", &[], Some(json!({"email":field(args,"email")?})))?)?;
            Ok(json!(field(&r, "msg")?))
        }
        "set_preferred_line" => {
            let raw = args["url"].as_str().ok_or("缺少线路地址")?;
            let ip = args["ip"].as_str().unwrap_or("");
            let url = if raw.is_empty() {
                String::new()
            } else {
                base_url(raw)?
            };
            let v = a.view(&a.data);
            if !url.is_empty()
                && (v["member"] != true
                    || !v["lines"].as_array().unwrap().iter().any(|l| l == &url))
            {
                return Err("需要有效会员及可用线路".into());
            }
            if !ip.is_empty() && ip.parse::<IpAddr>().is_err() {
                return Err("服务器 IP 无效".into());
            }
            let saved = a.update(|s| {
                s["preferred"] = json!(url);
                s["preferred_ip"] = json!(if url.is_empty() { "" } else { ip });
                Ok(())
            })?;
            Ok(a.view(&saved))
        }
        "set_accel_nodes" => {
            let n = nodes(&args["nodes"])?;
            let saved = a.update(|s| {
                apply_nodes(s, &n);
                Ok(())
            })?;
            Ok(a.view(&saved))
        }
        "set_hf_mirror" => {
            let mode = match args["mode"].as_str() {
                Some("off") => "off",
                Some("all") => "all",
                _ => "member",
            };
            ctx.update("settings", json!({}), |s| {
                s["hf_mirror"] = json!(mode);
                Ok(())
            })?;
            Ok(Value::Null)
        }
        _ => unreachable!(),
    }
}

pub fn handle(cmd: &str, a: &Value, ctx: &Ctx, _app: &tauri::AppHandle) -> Option<Reply> {
    match cmd {
        "client_config" => Some(client_config(ctx)),
        "poll_member" => Some(restore(ctx)),
        "accel_status" | "account_bases" | "account_ok" | "accel_plans" | "accel_create"
        | "accel_order" | "activate_code" | "accel_recover" | "set_preferred_line"
        | "set_accel_nodes" | "set_hf_mirror" => Some(run(cmd, a, ctx)),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
