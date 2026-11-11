//! Hosting a world for friends: the address to share and a port that stays
//! the same from one session to the next. Hosting itself stays off by default
//! and nothing here opens a firewall port; the OS asks the player on its own.

use std::fs;
use std::net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket};
use std::path::Path;

const PORT_FILE: &str = "host-port";
/// Ports below this need elevated rights on some systems and collide with
/// common services, so a saved preference never uses them.
const MIN_PORT: u16 = 1024;

/// The address of this computer on its local network, if it has one. Opening
/// a UDP socket toward a documentation address only asks the OS which
/// interface it would use; no packet is sent.
pub(crate) fn lan_address() -> Option<Ipv4Addr> {
  let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
  socket.connect(("192.0.2.1", 9)).ok()?;
  match socket.local_addr().ok()?.ip() {
    IpAddr::V4(ip) if usable_lan_address(ip) => Some(ip),
    _ => None,
  }
}

fn usable_lan_address(ip: Ipv4Addr) -> bool {
  !(ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast())
}

pub(crate) fn share_url(ip: Ipv4Addr, port: u16) -> String {
  format!("http://{ip}:{port}")
}

pub(crate) fn read_preferred_port(world_home: &Path) -> Option<u16> {
  let port: u16 = fs::read_to_string(world_home.join(PORT_FILE)).ok()?.trim().parse().ok()?;
  (port >= MIN_PORT).then_some(port)
}

pub(crate) fn remember_port(world_home: &Path, port: u16) {
  let _ = fs::write(world_home.join(PORT_FILE), port.to_string());
}

/// Whether the game could listen on this port on every interface, which is
/// what hosting does.
pub(crate) fn host_port_free(port: u16) -> bool {
  TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// The remembered port when it is still free and not taken by the world's own
/// database, otherwise whatever `fallback` finds.
pub(crate) fn choose_host_port(
  preferred: Option<u16>,
  taken: &[u16],
  is_free: impl Fn(u16) -> bool,
  fallback: impl FnOnce() -> Result<u16, String>,
) -> Result<u16, String> {
  match preferred {
    Some(port) if port >= MIN_PORT && !taken.contains(&port) && is_free(port) => Ok(port),
    _ => fallback(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_remembered_port_is_used_when_free() {
    assert_eq!(choose_host_port(Some(4100), &[], |_| true, || Ok(9)), Ok(4100));
  }

  #[test]
  fn a_busy_or_reserved_or_low_port_falls_back() {
    assert_eq!(choose_host_port(Some(4100), &[], |_| false, || Ok(9)), Ok(9));
    assert_eq!(choose_host_port(Some(4100), &[4100], |_| true, || Ok(9)), Ok(9));
    assert_eq!(choose_host_port(Some(80), &[], |_| true, || Ok(9)), Ok(9));
    assert_eq!(choose_host_port(None, &[], |_| true, || Ok(9)), Ok(9));
  }

  #[test]
  fn loopback_and_unset_addresses_are_not_shared() {
    assert!(!usable_lan_address(Ipv4Addr::LOCALHOST));
    assert!(!usable_lan_address(Ipv4Addr::UNSPECIFIED));
    assert!(usable_lan_address(Ipv4Addr::new(192, 168, 1, 20)));
    assert_eq!(share_url(Ipv4Addr::new(192, 168, 1, 20), 4100), "http://192.168.1.20:4100");
  }

  #[test]
  fn the_port_is_saved_per_world_folder() {
    let dir = std::env::temp_dir().join(format!("ahd-host-port-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(read_preferred_port(&dir), None);
    remember_port(&dir, 4100);
    assert_eq!(read_preferred_port(&dir), Some(4100));
    fs::write(dir.join(PORT_FILE), "80").unwrap();
    assert_eq!(read_preferred_port(&dir), None);
    let _ = fs::remove_dir_all(&dir);
  }
}
