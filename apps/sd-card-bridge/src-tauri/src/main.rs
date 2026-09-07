#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fcm_sd_card_bridge_lib::run();
}