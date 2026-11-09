use crate::{Ctx, Reply};
use reqwest::{
    blocking::{Client, Response},
    header::{HeaderValue, LOCATION},
    StatusCode, Url,
};
use serde_json::{json, Value};
use std::{
    io::Read,
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

const MEMBER_LINES: [&str; 2] = ["https://m1.locmodel.com", "https://m2.locmodel.com"];
const HF: &str = "https://huggingface.co";

struct Route {
    endpoint: Url,
    client: Client,
    member: bool,
    token: String,
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn member_lines(account: &Value) -> Vec<&str> {
    let official = account["official"] == true;
    let mut lines = Vec::new();
    for line in account["trusted_lines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let line = line.trim_end_matches('/');
        let Ok(url) = Url::parse(line) else { continue };
        let local = url.host_str().is_some_and(|h| {
            h == "localhost"
                || h.trim_matches(['[', ']'])
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if url.scheme() != "https" && !(url.scheme() == "http" && local && !official) {
            continue;
        }
        if !official && MEMBER_LINES.contains(&url.origin().ascii_serialization().as_str()) {
            continue;
        }
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    if official {
        for origin in MEMBER_LINES {
            if !lines.contains(&origin) {
                lines.push(origin);
            }
        }
    }
    lines.sort_by_key(|line| *line != field(account, "preferred").trim_end_matches('/'));
    lines
}

pub(super) fn validate_path(path: &str) -> Result<(), String> {
    if path.split('/').any(|s| {
        s.is_empty()
            || s == "."
            || s == ".."
            || s.contains(['\\', ':'])
            || s.chars().any(char::is_control)
    }) {
        return Err("仓库文件路径无效".into());
    }
    Ok(())
}

pub(super) fn strong_etag(r: &Response) -> Option<&str> {
    r.headers()
        .get("etag")?
        .to_str()
        .ok()
        .filter(|s| s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
}
impl Route {
    fn new(
        endpoint: &str,
        member: bool,
        token: &str,
        pinned: Option<IpAddr>,
    ) -> Result<Self, String> {
        let endpoint = Url::parse(endpoint).map_err(|_| "镜像地址无效")?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("镜像地址必须是 HTTP 或 HTTPS 基地址".into());
        }
        let mut builder = Client::builder()
            .user_agent("LocModel/3.1.0")
            .connect_timeout(Duration::from_secs(12))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(ip) = pinned.filter(|ip| endpoint.scheme() == "https" || ip.is_loopback()) {
            builder = builder.no_proxy().resolve(
                endpoint.host_str().unwrap(),
                SocketAddr::new(ip, endpoint.port_or_known_default().unwrap()),
            );
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        Ok(Self {
            endpoint,
            client,
            member,
            token: token.into(),
        })
    }

    fn url(&self, api: bool, parts: &[&str]) -> Result<Url, String> {
        let mut url = self.endpoint.clone();
        let mut segments = url.path_segments_mut().unwrap();
        segments.pop_if_empty();
        if api {
            segments.push("api");
        }
        if self.member {
            segments.push("hf");
        }
        for (index, part) in parts.iter().enumerate() {
            // The paid gateway exposes the main branch. Public Hub URLs accept a commit.
            let part = if self.member && !api && index == 2 && parts.get(1) == Some(&"resolve") {
                "main"
            } else {
                part
            };
            validate_path(part)?;
            for s in part.split('/') {
                segments.push(s);
            }
        }
        drop(segments);
        Ok(url)
    }

    fn send(
        &self,
        mut url: Url,
        api: bool,
        range: Option<(u64, Option<&str>)>,
    ) -> Result<Response, String> {
        // Rebuild each redirect request. reqwest does not strip X-Launcher-Token.
        let mut authenticated = !self.token.is_empty();
        for _ in 0..10 {
            let mut request = self.client.get(url.clone());
            if api {
                request = request.timeout(Duration::from_secs(35));
            }
            if let Some((offset, validator)) = range {
                request = request.header("Range", format!("bytes={offset}-"));
                if let Some(tag) = validator {
                    request = request.header("If-Range", tag);
                }
            }
            if authenticated {
                if self.member {
                    let mut header =
                        HeaderValue::from_str(&self.token).map_err(|_| "会员令牌格式无效")?;
                    header.set_sensitive(true);
                    request = request.header("X-Launcher-Token", header);
                } else {
                    request = request.bearer_auth(&self.token);
                }
            }
            let response = request.send().map_err(|e| e.without_url().to_string())?;
            if !response.status().is_redirection() {
                return Ok(response);
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|s| s.to_str().ok())
                .ok_or("下载重定向缺少地址")?;
            let target = url.join(location).map_err(|_| "下载重定向地址无效")?;
            if !matches!(target.scheme(), "https" | "http")
                || (url.scheme() == "https" && target.scheme() != "https")
                || !target.username().is_empty()
                || target.password().is_some()
            {
                return Err("下载重定向地址无效".into());
            }
            authenticated &= target.origin() == url.origin();
            url = target;
        }
        Err("下载重定向次数过多".into())
    }
}

pub(crate) struct Routes<'a> {
    routes: Vec<Route>,
    ctx: &'a Ctx,
}

impl<'a> Routes<'a> {
    pub(crate) fn new(ctx: &'a Ctx) -> Result<Self, String> {
        Self::from_settings(ctx, &ctx.settings()?, &crate::account::status(ctx)?)
    }

    fn from_settings(ctx: &'a Ctx, settings: &Value, account: &Value) -> Result<Self, String> {
        let mut routes = Vec::new();
        let token = field(account, "token");
        if account["member"] == true && !token.is_empty() {
            for origin in member_lines(account) {
                let pinned = (field(account, "preferred").trim_end_matches('/') == origin)
                    .then(|| field(account, "preferred_ip").parse().ok())
                    .flatten();
                if pinned.is_some() {
                    routes.push(Route::new(origin, true, token, pinned)?);
                }
                routes.push(Route::new(origin, true, token, None)?);
            }
        }
        let mirror = field(settings, "custom_mirror").trim_end_matches('/');
        let public = if !mirror.is_empty() {
            mirror
        } else if settings["hf_mirror"] == "on" {
            "https://hf-mirror.com"
        } else {
            HF
        };
        let hf = field(settings, "hf_token");
        routes.push(Route::new(
            public,
            false,
            if public == HF { hf } else { "" },
            None,
        )?);
        Ok(Self { routes, ctx })
    }

    pub(crate) fn fetch(
        &self,
        api: bool,
        parts: &[&str],
        query: &[(&str, &str)],
        range: Option<(u64, Option<&str>)>,
    ) -> Result<(Response, &'static str), String> {
        let result = self.attempt(api, parts, query, range);
        if result
            .as_ref()
            .is_err_and(|e| e.starts_with("MEMBER_EXPIRED|"))
        {
            if crate::account::restore(self.ctx).is_ok_and(|s| s["member"] == true) {
                return Self::new(self.ctx)?.attempt(api, parts, query, range);
            }
        }
        result
    }

    fn attempt(
        &self,
        api: bool,
        parts: &[&str],
        query: &[(&str, &str)],
        range: Option<(u64, Option<&str>)>,
    ) -> Result<(Response, &'static str), String> {
        let mut last = String::new();
        for route in &self.routes {
            let mut url = route.url(api, parts)?;
            if !query.is_empty() {
                url.query_pairs_mut().extend_pairs(query);
            }
            // A member URL follows main and can change between two requests.
            let mut range = range.filter(|(_, tag)| !route.member || tag.is_some());
            let result = route.send(url.clone(), api, range);
            let response = match result {
                Ok(r) => r,
                Err(e) => {
                    last = if self.routes.len() == 1
                        && [HF, "https://hf-mirror.com"]
                            .contains(&route.endpoint.origin().ascii_serialization().as_str())
                    {
                        format!("NEED_ACCEL|无法连接模型源（{e}）")
                    } else {
                        e
                    };
                    continue;
                }
            };
            let response = if response.status() == StatusCode::PARTIAL_CONTENT
                && range.is_some_and(|(_, tag)| tag.is_some() && tag != strong_etag(&response))
            {
                range = None;
                match route.send(url, api, None) {
                    Ok(r) => r,
                    Err(e) => {
                        last = e;
                        continue;
                    }
                }
            } else {
                response
            };
            let status = response.status();
            if status == StatusCode::PARTIAL_CONTENT && range.is_none() {
                return Err("服务器返回了未请求的分段".into());
            }
            if status.is_success()
                || (range.is_some() && status == StatusCode::RANGE_NOT_SATISFIABLE)
            {
                return Ok((
                    response,
                    if route.member {
                        "高速下载"
                    } else if route.endpoint.origin().ascii_serialization() == HF {
                        "官方源"
                    } else {
                        "镜像源"
                    },
                ));
            }
            if route.member
                && response.url().origin() == route.endpoint.origin()
                && matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            {
                let mut body = Vec::new();
                let _ = response.take(2048).read_to_end(&mut body);
                let reason = String::from_utf8_lossy(&body);
                if reason.contains("MEMBER_EXPIRED")
                    || reason.contains("高速下载授权")
                    || reason.contains("会员")
                    || reason.contains("令牌已过期")
                {
                    return Err(
                        "MEMBER_EXPIRED|高速下载服务未接受当前授权，请重新验证激活码".into(),
                    );
                }
            }
            last = format!("模型服务器返回 HTTP {status}");
        }
        Err(last)
    }
}

pub(crate) fn ping_servers(ctx: &Ctx) -> Reply {
    let account = crate::account::status(ctx)?;
    let mut rows = Vec::new();
    for line in member_lines(&account) {
        let Ok(url) = Url::parse(line) else { continue };
        let Some(host) = url.host_str() else { continue };
        let mut addresses = (host, url.port_or_known_default().unwrap())
            .to_socket_addrs()
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        addresses.sort();
        addresses.dedup();
        for address in addresses {
            let start = Instant::now();
            let ok = TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_ok();
            rows.push(json!({"line":line,"ip":address.ip().to_string(),"ms":start.elapsed().as_millis(),"ok":ok}));
        }
    }
    Ok(json!(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
    };

    fn server(reply: String) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        (
            origin,
            thread::spawn(move || {
                let (mut conn, _) = listener.accept().unwrap();
                let request = BufReader::new(&conn)
                    .lines()
                    .map(Result::unwrap)
                    .take_while(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                conn.write_all(reply.as_bytes()).unwrap();
                request.to_ascii_lowercase()
            }),
        )
    }

    #[test]
    fn member_file_redirect_preserves_range_but_removes_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().into()).unwrap();
        let (cdn, cdn_request) = server(
            "HTTP/1.1 206 Partial Content\r\nETag: \"v1\"\r\nContent-Length: 2\r\n\r\nOK".into(),
        );
        let (paid, paid_request) = server(format!(
            "HTTP/1.1 302 Found\r\nLocation: {cdn}/asset\r\nContent-Length: 0\r\n\r\n"
        ));
        let routes = Routes::from_settings(
            &ctx,
            &json!({"hf_token":"fixture-hf"}),
            &json!({"member":true,"token":"fixture-member","trusted_lines":[paid]}),
        )
        .unwrap();
        let (r, label) = routes
            .fetch(
                false,
                &["a/b", "resolve", "commit-id", "sub/model.gguf"],
                &[],
                Some((5, Some("\"v1\""))),
            )
            .unwrap();
        assert_eq!(r.text().unwrap(), "OK");
        assert_eq!(label, "高速下载");
        let paid = paid_request.join().unwrap();
        assert!(paid.starts_with("get /hf/a/b/resolve/main/sub/model.gguf "));
        assert!(paid.contains("x-launcher-token: fixture-member"));
        assert!(!paid.contains("fixture-hf"));
        let cdn = cdn_request.join().unwrap();
        assert!(cdn.contains("range: bytes=5-"));
        assert!(cdn.contains("if-range: \"v1\""));
        assert!(!cdn.contains("fixture-member"));
        assert!(!cdn.contains("fixture-hf"));
    }

    #[test]
    fn unavailable_member_metadata_falls_back_without_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().into()).unwrap();
        let (public, public_request) =
            server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]".into());
        let (paid, paid_request) =
            server("HTTP/1.1 403 Forbidden\r\nContent-Length: 5\r\n\r\ngated".into());
        let account = json!({"member":true,"token":"fixture-member","trusted_lines":[paid],
            "nodes":[{"url":"https://example.invalid"}],"preferred":"https://example.invalid"});
        let routes = Routes::from_settings(
            &ctx,
            &json!({"custom_mirror": public, "hf_token":"fixture-hf"}),
            &account,
        )
        .unwrap();
        let (r, label) = routes
            .fetch(true, &["models", "a/b"], &[("blobs", "true")], None)
            .unwrap();
        assert_eq!(r.text().unwrap(), "[]");
        assert_eq!(label, "镜像源");
        assert!(paid_request
            .join()
            .unwrap()
            .starts_with("get /api/hf/models/a/b?blobs=true "));
        let public = public_request.join().unwrap();
        assert!(public.starts_with("get /api/models/a/b?blobs=true "));
        assert!(!public.contains("fixture-"));
    }

    #[test]
    fn changed_member_etag_restarts_without_range() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().into()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            for n in 0..2 {
                let (mut conn, _) = listener.accept().unwrap();
                let headers = BufReader::new(&conn)
                    .lines()
                    .map(Result::unwrap)
                    .take_while(|l| !l.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
                    .to_ascii_lowercase();
                if n == 0 {
                    assert!(headers.contains("range: bytes=2-"));
                    conn.write_all(b"HTTP/1.1 206 Partial Content\r\nETag: \"changed\"\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx").unwrap();
                } else {
                    assert!(!headers.contains("range:"));
                    conn.write_all(b"HTTP/1.1 200 OK\r\nETag: \"changed\"\r\nContent-Length: 3\r\nConnection: close\r\n\r\nNEW").unwrap();
                }
            }
        });
        let routes = Routes::from_settings(
            &ctx,
            &json!({}),
            &json!({"member":true,"token":"fixture","trusted_lines":[origin]}),
        )
        .unwrap();
        let (r, _) = routes
            .fetch(
                false,
                &["a/b", "resolve", "sha", "f"],
                &[],
                Some((2, Some("\"old\""))),
            )
            .unwrap();
        assert_eq!(r.text().unwrap(), "NEW");
        worker.join().unwrap();
    }

    #[test]
    fn only_authority_scoped_lines_can_receive_its_token() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().into()).unwrap();
        let account = json!({"member":true,"official":false,"token":"fixture","trusted_lines":[MEMBER_LINES[0],"http://example.com"]});
        let settings = json!({"accel_lines":["https://example.com"],"custom_mirror":"https://huggingface.co:8080","hf_token":"fixture-hf"});
        let routes = Routes::from_settings(&ctx, &settings, &account).unwrap();
        assert_eq!(routes.routes.len(), 1);
        assert!(routes.routes[0].token.is_empty());
        let free = json!({"member":false,"official":true,"token":"expired"});
        let routes = Routes::from_settings(&ctx, &settings, &free).unwrap();
        assert!(routes.routes.iter().all(|r| !r.member));
        assert_eq!(
            member_lines(&json!({"official":true,"preferred":MEMBER_LINES[1]})),
            [MEMBER_LINES[1], MEMBER_LINES[0]]
        );
    }
}
