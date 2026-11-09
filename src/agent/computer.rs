use super::{arg, err, Reply};
use base64::{engine::general_purpose::STANDARD, Engine};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use screenshots::{
    image::{self, DynamicImage, ImageOutputFormat},
    Screen,
};
use serde_json::{json, Value};
use std::{io::Cursor, thread, time::Duration};

pub(super) fn shot() -> Reply {
    let screen = Screen::all()
        .map_err(err)?
        .into_iter()
        .find(|s| s.display_info.is_primary)
        .ok_or("没有主显示器")?;
    let pixels = screen.capture().map_err(err)?;
    // Return the coordinate space used by native mouse events (points on Retina screens).
    let (w, h) = (screen.display_info.width, screen.display_info.height);
    let img = DynamicImage::ImageRgba8(pixels);
    let img = if img.width() != w || img.height() != h {
        img.resize_exact(w, h, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut data = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(img.to_rgb8())
        .write_to(&mut data, ImageOutputFormat::Jpeg(75))
        .map_err(err)?;
    Ok(
        json!({"width":w,"height":h,"data_url":format!("data:image/jpeg;base64,{}",STANDARD.encode(data.into_inner()))}),
    )
}
fn key(s: &str) -> Result<Key, String> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Key::Control,
        "cmd" | "command" | "meta" | "win" | "super" => Key::Meta,
        "shift" => Key::Shift,
        "option" | "alt" => Key::Alt,
        "enter" | "return" => Key::Return,
        "esc" | "escape" => Key::Escape,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        k if k.chars().count() == 1 => Key::Unicode(k.chars().next().unwrap()),
        _ => return Err(format!("不支持按键 {s}")),
    })
}
pub(super) fn act(a: &Value) -> Reply {
    let action = arg(a, "action")?;
    if action == "wait" {
        thread::sleep(Duration::from_secs(2));
    } else {
        let mut input = Enigo::new(&Settings::default()).map_err(err)?;
        let point = match (a["x"].as_f64(), a["y"].as_f64()) {
            (Some(x), Some(y)) => Some((x.round() as i32, y.round() as i32)),
            (None, None) => None,
            _ => return Err("请同时提供 x 和 y".into()),
        };
        match action {
            "click" | "double_click" | "right_click" | "move" | "type" | "scroll" => {
                if let Some((x, y)) = point {
                    let (w, h) = input.main_display().map_err(err)?;
                    if x < 0 || y < 0 || x >= w || y >= h {
                        return Err("坐标不在主显示器范围内".into());
                    }
                    input.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
                } else if !matches!(action, "type" | "scroll") {
                    return Err("缺少屏幕坐标".into());
                }
                match action {
                    "click" => input.button(Button::Left, Direction::Click).map_err(err)?,
                    "right_click" => input.button(Button::Right, Direction::Click).map_err(err)?,
                    "double_click" => {
                        input.button(Button::Left, Direction::Click).map_err(err)?;
                        thread::sleep(Duration::from_millis(60));
                        input.button(Button::Left, Direction::Click).map_err(err)?;
                    }
                    "type" => {
                        if point.is_some() {
                            input.button(Button::Left, Direction::Click).map_err(err)?;
                        }
                        input.text(arg(a, "text")?).map_err(err)?;
                    }
                    "scroll" => input
                        .scroll(
                            a["amount"].as_i64().unwrap_or(3).clamp(-1000, 1000) as i32,
                            Axis::Vertical,
                        )
                        .map_err(err)?,
                    _ => {}
                }
            }
            "key" => {
                let keys = arg(a, "keys")?
                    .split('+')
                    .map(key)
                    .collect::<Result<Vec<_>, _>>()?;
                let (last, mods) = keys.split_last().ok_or("缺少按键")?;
                for &k in mods {
                    input.key(k, Direction::Press).map_err(err)?;
                }
                input.key(*last, Direction::Click).map_err(err)?;
                for &k in mods.iter().rev() {
                    input.key(k, Direction::Release).map_err(err)?;
                }
            }
            _ => return Err(format!("未知电脑操作 {action}")),
        }
        thread::sleep(Duration::from_millis(250));
    }
    Ok(json!({"message":format!("已执行 {action}"),"shot":shot()?}))
}
