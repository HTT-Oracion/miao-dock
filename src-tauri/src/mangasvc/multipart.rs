// multipart/form-data 解析 —— 移植 `service/src/multipart.mjs`（Node 内置实现的等价物）。
//
// 只做本项目需要的部分：字段 name / filename / contentType / 原始字节。
//
// 🔴 严格边界（RFC 2046）：分隔符 = `CRLF "--" boundary`，且**紧跟** `CRLF`（普通分片）
//    或 `--`（结束分片）。只做"子串命中"会把图片字节里恰好出现的 `\r\n--<boundary>X`
//    误判成边界 ⇒ 分片错位 / 串图 / 张数错（甚至绕过 20 张上限计数）。
use std::collections::HashMap;

use regex::Regex;

use crate::mangasvc::store::StoreError;

/// 一个分片。
#[derive(Clone, Debug)]
pub struct Part {
    pub name: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

/// 解析结果。`complete=false` 表示请求体未以结束分隔符 `--boundary--` 收尾（被截断）。
#[derive(Clone, Debug)]
pub struct Parsed {
    pub parts: Vec<Part>,
    pub complete: bool,
}

/// 整理成 `{ fields, files }`（`images[]` 与 `images` 视为同一字段）。
#[derive(Default, Debug)]
pub struct Grouped {
    pub fields: HashMap<String, Vec<Vec<u8>>>,
    pub files: HashMap<String, Vec<Part>>,
}

fn find_subslice(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() || from > hay.len() - needle.len() {
        return None;
    }
    let first = needle[0];
    let last_start = hay.len() - needle.len();
    let mut i = from;
    while i <= last_start {
        if hay[i] == first && &hay[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// `getBoundary`：从 Content-Type 里取 boundary。
pub fn get_boundary(content_type: &str) -> Option<String> {
    if content_type.is_empty() {
        return None;
    }
    let re = Regex::new(r#"(?i)boundary=(?:"([^"]+)"|([^;]+))"#).ok()?;
    let caps = re.captures(content_type)?;
    let raw = caps
        .get(1)
        .or_else(|| caps.get(2))
        .map(|m| m.as_str())
        .unwrap_or("")
        .trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// 严格寻找下一个分隔符：返回 `(start, after)`；`start` = 分片内容结束处，`after` = 紧随 boundary 之后。
fn find_next_delimiter(body: &[u8], dash_boundary: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut needle = Vec::with_capacity(2 + dash_boundary.len());
    needle.extend_from_slice(b"\r\n");
    needle.extend_from_slice(dash_boundary);
    let mut at = from;
    loop {
        let pos = find_subslice(body, &needle, at)?;
        let after = pos + needle.len();
        let a = body.get(after).copied();
        let b = body.get(after + 1).copied();
        let is_normal = a == Some(0x0d) && b == Some(0x0a);
        let is_close = a == Some(0x2d) && b == Some(0x2d);
        if is_normal || is_close {
            return Some((pos, after));
        }
        at = pos + 1; // 伪边界，继续找下一个
    }
}

fn parse_headers(block: &[u8]) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    let text = String::from_utf8_lossy(block);
    for line in text.split("\r\n") {
        if let Some(idx) = line.find(':') {
            let key = line[..idx].trim().to_lowercase();
            let val = line[idx + 1..].trim().to_string();
            headers.insert(key, val);
        }
    }
    headers
}

fn parse_disposition(value: Option<&str>) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut filename = None;
    let Some(v) = value else { return (name, filename) };
    if v.is_empty() {
        return (name, filename);
    }
    for piece in v.split(';').skip(1) {
        let Some(eq) = piece.find('=') else { continue };
        let key = piece[..eq].trim().to_lowercase();
        let mut val = piece[eq + 1..].trim().to_string();
        if val.starts_with('"') && val.ends_with('"') && val.len() >= 2 {
            val = val[1..val.len() - 1].replace("\\\"", "\"");
        }
        if key == "name" {
            name = Some(val);
        } else if key == "filename" {
            filename = Some(val);
        }
    }
    (name, filename)
}

/// `parseMultipartEx`。返回 `None` 表示缺 boundary。
pub fn parse_multipart_ex(body: &[u8], content_type: &str) -> Option<Parsed> {
    let boundary = get_boundary(content_type)?;
    let mut dash_boundary = Vec::with_capacity(2 + boundary.len());
    dash_boundary.extend_from_slice(b"--");
    dash_boundary.extend_from_slice(boundary.as_bytes());

    // 首个 delimiter 允许出现在 body 开头（其后必须紧跟 CRLF 或 --）
    let after_first = if body.len() >= dash_boundary.len() && &body[..dash_boundary.len()] == dash_boundary.as_slice() {
        dash_boundary.len()
    } else {
        let mut crlf_boundary = Vec::with_capacity(2 + dash_boundary.len());
        crlf_boundary.extend_from_slice(b"\r\n");
        crlf_boundary.extend_from_slice(&dash_boundary);
        match find_subslice(body, &crlf_boundary, 0) {
            Some(at) => at + 2 + dash_boundary.len(),
            None => return Some(Parsed { parts: Vec::new(), complete: false }),
        }
    };

    let mut parts = Vec::new();
    let mut cursor = after_first;
    let mut complete = false;
    loop {
        let c0 = body.get(cursor).copied();
        let c1 = body.get(cursor + 1).copied();
        if c0 == Some(0x2d) && c1 == Some(0x2d) {
            complete = true;
            break;
        }
        if c0 != Some(0x0d) || c1 != Some(0x0a) {
            break;
        }
        let part_start = cursor + 2;
        let Some((delim_start, delim_after)) = find_next_delimiter(body, &dash_boundary, part_start) else {
            break;
        };
        let chunk = &body[part_start..delim_start];
        if let Some(header_end) = find_subslice(chunk, b"\r\n\r\n", 0) {
            let headers = parse_headers(&chunk[..header_end]);
            let (name, filename) = parse_disposition(headers.get("content-disposition").map(|s| s.as_str()));
            parts.push(Part {
                name,
                filename,
                content_type: headers.get("content-type").cloned(),
                data: chunk[header_end + 4..].to_vec(),
            });
        }
        cursor = delim_after;
    }
    Some(Parsed { parts, complete })
}

fn normalize_field_name(name: &str) -> String {
    name.strip_suffix("[]").unwrap_or(name).to_string()
}

/// `groupParts`。
pub fn group_parts(parts: Vec<Part>) -> Grouped {
    let mut g = Grouped::default();
    for part in parts {
        let Some(raw_name) = part.name.as_deref() else { continue };
        if raw_name.is_empty() {
            continue;
        }
        let key = normalize_field_name(raw_name);
        if key.is_empty() {
            continue;
        }
        if part.filename.is_some() {
            g.files.entry(key).or_default().push(part);
        } else {
            g.fields.entry(key).or_default().push(part.data);
        }
    }
    g
}

/// `firstField`。
pub fn first_field(fields: &HashMap<String, Vec<Vec<u8>>>, key: &str) -> Option<String> {
    fields.get(key).and_then(|a| a.first()).map(|b| String::from_utf8_lossy(b).into_owned())
}

/// `allFieldStrings`。
pub fn all_field_strings(fields: &HashMap<String, Vec<Vec<u8>>>, key: &str) -> Vec<String> {
    fields
        .get(key)
        .map(|a| a.iter().map(|b| String::from_utf8_lossy(b).into_owned()).collect())
        .unwrap_or_default()
}

/// `extractPayloadField`：`payload` 既可能是普通字段，也可能是被当文件上传的 part。
pub fn extract_payload_field(fields: &HashMap<String, Vec<Vec<u8>>>, files: &HashMap<String, Vec<Part>>) -> serde_json::Value {
    let mut raw = first_field(fields, "payload");
    if raw.is_none() {
        if let Some(list) = files.get("payload") {
            if let Some(p) = list.first() {
                raw = Some(String::from_utf8_lossy(&p.data).into_owned());
            }
        }
    }
    let Some(raw) = raw else { return serde_json::json!({}) };
    if raw.trim().is_empty() {
        return serde_json::json!({});
    }
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v @ serde_json::Value::Object(_)) => v,
        _ => serde_json::json!({}),
    }
}

/// `groupMultipart`：四道公共闸（Content-Type → Content-Length 一致 → boundary 存在 → 收尾）。
///
/// 少一道闸，就意味着某条上传路径会**静默少收几张图**（截断的请求体照样能解析出前半段）。
pub fn group_multipart(content_type: &str, declared_len: Option<&str>, body: &[u8]) -> Result<Grouped, StoreError> {
    if !content_type.to_ascii_lowercase().contains("multipart/form-data") {
        return Err(StoreError::new(
            "INVALID_IMAGE",
            "Content-Type 必须是 multipart/form-data",
            serde_json::json!({ "contentType": content_type }),
        ));
    }
    if let Some(parsed_len) = declared_len.and_then(|s| s.trim().parse::<i64>().ok()) {
        if parsed_len != body.len() as i64 {
            return Err(StoreError::new(
                "INVALID_IMAGE",
                "Content-Length 与实际请求体字节数不一致",
                serde_json::json!({ "contentLength": parsed_len, "actualBytes": body.len() }),
            ));
        }
    }
    let Some(parsed) = parse_multipart_ex(body, content_type) else {
        return Err(StoreError::new("INVALID_IMAGE", "multipart 缺少 boundary", serde_json::json!({})));
    };
    if !parsed.complete {
        return Err(StoreError::new(
            "INVALID_IMAGE",
            "multipart 请求体被截断（缺少结束分隔符）",
            serde_json::json!({ "bytes": body.len() }),
        ));
    }
    Ok(group_parts(parsed.parts))
}

/// 上传的一张图（Node 的 `{filename, contentType, data}`）。
#[derive(Clone, Debug)]
pub struct UploadImage {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

/// 解析上传表单：payload + images[] + imageOrder[]。
pub fn parse_upload_request(
    content_type: &str,
    declared_len: Option<&str>,
    body: &[u8],
) -> Result<(serde_json::Value, Vec<UploadImage>, Vec<serde_json::Value>), StoreError> {
    let g = group_multipart(content_type, declared_len, body)?;
    let images: Vec<UploadImage> = g
        .files
        .get("images")
        .map(|list| {
            list.iter()
                .map(|p| UploadImage {
                    filename: p.filename.clone(),
                    content_type: p.content_type.clone(),
                    data: p.data.clone(),
                })
                .collect()
        })
        .unwrap_or_default();

    if images.is_empty() {
        return Err(StoreError::new(
            "INVALID_IMAGE",
            "images[] 缺失或为空（至少需要 1 张图片）",
            serde_json::json!({ "submitted": 0 }),
        ));
    }
    let limit = crate::mangasvc::store::model::BATCH_LIMIT;
    if images.len() as i64 > limit {
        return Err(StoreError::new(
            "BATCH_LIMIT_EXCEEDED",
            format!("单次最多提交 {limit} 张，当前 {} 张", images.len()),
            serde_json::json!({ "limit": limit, "submitted": images.len() }),
        ));
    }

    let payload = extract_payload_field(&g.fields, &g.files);
    let image_order: Vec<serde_json::Value> = all_field_strings(&g.fields, "imageOrder")
        .into_iter()
        .map(serde_json::Value::String)
        .collect();
    Ok((payload, images, image_order))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_of(boundary: &str, parts: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
        let mut b = Vec::new();
        for (name, filename, data) in parts {
            b.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            let disp = match filename {
                Some(f) => format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n"),
                None => format!("Content-Disposition: form-data; name=\"{name}\"\r\n"),
            };
            b.extend_from_slice(disp.as_bytes());
            b.extend_from_slice(b"\r\n");
            b.extend_from_slice(data);
            b.extend_from_slice(b"\r\n");
        }
        b.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        b
    }

    #[test]
    fn parses_fields_and_files() {
        let ct = "multipart/form-data; boundary=BOUND";
        let body = body_of("BOUND", &[("payload", None, br#"{"comicName":"x"}"#), ("images", Some("a.png"), b"\x89PNG")]);
        let g = group_multipart(ct, None, &body).unwrap();
        assert_eq!(g.fields.get("payload").unwrap().len(), 1);
        assert_eq!(g.files.get("images").unwrap().len(), 1);
        let payload = extract_payload_field(&g.fields, &g.files);
        assert_eq!(payload.get("comicName").unwrap().as_str().unwrap(), "x");
    }

    #[test]
    fn rejects_truncated_body() {
        let ct = "multipart/form-data; boundary=B";
        let mut body = body_of("B", &[("a", None, b"1")]);
        body.truncate(body.len() - 6); // 砍掉结束分隔符
        assert_eq!(group_multipart(ct, None, &body).unwrap_err().code, "INVALID_IMAGE");
    }

    #[test]
    fn rejects_missing_boundary_and_bad_content_type() {
        assert_eq!(group_multipart("text/plain", None, b"x").unwrap_err().code, "INVALID_IMAGE");
        assert_eq!(group_multipart("multipart/form-data", None, b"x").unwrap_err().code, "INVALID_IMAGE");
    }

    #[test]
    fn content_length_mismatch_is_rejected() {
        let ct = "multipart/form-data; boundary=B";
        let body = body_of("B", &[("a", None, b"1")]);
        let declared = (body.len() - 1).to_string();
        assert_eq!(group_multipart(ct, Some(&declared), &body).unwrap_err().code, "INVALID_IMAGE");
    }

    #[test]
    fn images_bracket_name_is_normalized() {
        let ct = "multipart/form-data; boundary=B";
        let body = body_of("B", &[("images[]", Some("a.png"), b"img")]);
        let (_, images, _) = parse_upload_request(ct, None, &body).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].filename.as_deref(), Some("a.png"));
    }
}
