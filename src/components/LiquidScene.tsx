"use client";
// The liquid moment: a chrome mass (metaballs) above three glass vaults pours into each vault as that leg's
// transactions pass (simulated) or confirm (live). Vault colours match the intro's lamps: amber IXS, cyan
// Robinhood Chain, blue Base. Fill height = the leg's share of the plan.
// Rebalances pass `from` (levels before the moves): vaults that shrink stream back up into the mass (idle capital),
// vaults that grow receive streams.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { VENUES, type VenueId } from "@/lib/config";
import type { Move } from "@/lib/rebalance";
import type { Leg, Position } from "@/lib/types";
import type { Execution } from "@/lib/use-t1000";

type Slot = { venue: VenueId; x: number; color: number; css: string };
const SLOTS: Slot[] = [
  { venue: "ixs", x: -2.15, color: 0xffa24a, css: "#ffb56b" },
  { venue: "rh_eth", x: 0, color: 0x4fe3e0, css: "#6ff0ec" },
  { venue: "base", x: 2.15, color: 0x3d6bff, css: "#7f9cff" },
];
const VAULT_BOTTOM = -2.05;
const VAULT_H = 1.55;
const MAX_FILL = 1.42;
const BLOB = new THREE.Vector3(0, 1.2, 0);
const MC_POS = new THREE.Vector3(0, 0, 0);
const MC_SCALE = 3.6;

export type VaultStatus = "idle" | "flowing" | "filled" | "failed";

export function vaultStatus(venue: VenueId, execution: Execution | null): { status: VaultStatus; note: string } {
  const steps = execution?.steps.filter((s) => s.venue === venue) ?? [];
  if (!execution || steps.length === 0) return { status: "idle", note: "" };
  if (steps.some((s) => s.ok === false)) return { status: "failed", note: "FAILED" };
  const done = steps.filter((s) => s.ok).length;
  if (done === steps.length) {
    if (execution.mode === "simulate") return { status: "filled", note: "SIMULATED" };
    return { status: "filled", note: venue === "ixs" ? "REQUESTED · SETTLES T+1" : "CONFIRMED" };
  }
  return { status: done > 0 ? "flowing" : "idle", note: done > 0 ? (execution.mode === "live" ? "SENDING…" : "SIMULATING…") : "QUEUED" };
}

/** Vault levels before and after a set of moves, both as shares of the value held before them. */
export function rebalanceLegs(positions: Position[], moves: Move[]): { from: Leg[]; to: Leg[] } {
  const total = positions.reduce((a, p) => a + p.usd, 0) || 1;
  const from = positions.map((p) => ({ venue: p.venue, usd: p.usd, pct: (p.usd / total) * 100 }));
  const to = from.map((l) => {
    const usd = Math.max(0, moves.reduce((a, m) => a + (m.to === l.venue ? m.usd : 0) - (m.from === l.venue ? m.usd : 0), l.usd));
    return { venue: l.venue, usd: Math.round(usd * 100) / 100, pct: (usd / total) * 100 };
  });
  return { from, to };
}

const toCube = (v: THREE.Vector3) => [
  (v.x - MC_POS.x) / (2 * MC_SCALE) + 0.5,
  (v.y - MC_POS.y) / (2 * MC_SCALE) + 0.5,
  (v.z - MC_POS.z) / (2 * MC_SCALE) + 0.5,
] as const;

export function LiquidScene({ legs, execution, from }: { legs: Leg[]; execution: Execution | null; from?: Leg[] }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Live data for the render loop, updated from props without re-creating the scene.
  const live = useRef({ legs, execution, from });
  useEffect(() => { live.current = { legs, execution, from }; }, [legs, execution, from]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0.3, 10.4);
    camera.lookAt(0, -0.35, 0);

    const chrome = new THREE.MeshStandardMaterial({ color: 0xe8ecf2, metalness: 1, roughness: 0.07, envMapIntensity: 1.35 });
    const glass = (tint: number) => new THREE.MeshPhysicalMaterial({
      color: tint, metalness: 0, roughness: 0.04, transmission: 0.92, thickness: 0.25, ior: 1.45,
      transparent: true, opacity: 0.55, side: THREE.DoubleSide, envMapIntensity: 1.2,
    });

    const vaults = SLOTS.map((slot) => {
      const group = new THREE.Group();
      group.position.set(slot.x, 0, 0);
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, VAULT_H, 48, 1, true), glass(slot.color));
      shell.position.y = VAULT_BOTTOM + VAULT_H / 2;
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.74, 0.12, 48),
        new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.8, roughness: 0.35, emissive: slot.color, emissiveIntensity: 0.25 }),
      );
      base.position.y = VAULT_BOTTOM - 0.06;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.63, 0.018, 12, 64),
        new THREE.MeshStandardMaterial({ color: slot.color, emissive: slot.color, emissiveIntensity: 1.4 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = VAULT_BOTTOM + VAULT_H;
      const target = new THREE.Mesh(
        new THREE.TorusGeometry(0.6, 0.008, 8, 64),
        new THREE.MeshBasicMaterial({ color: slot.color, transparent: true, opacity: 0 }),
      );
      target.rotation.x = Math.PI / 2;
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1, 48), chrome);
      column.visible = false;
      const light = new THREE.PointLight(slot.color, 9, 6, 1.6);
      light.position.set(0, VAULT_BOTTOM + VAULT_H + 0.6, 1.1);
      group.add(shell, base, ring, target, column, light);
      scene.add(group);
      const start = (live.current.from?.find((l) => l.venue === slot.venue)?.pct ?? 0) / 100;
      return { slot, group, column, target, shell, level: start * MAX_FILL, streamT: 0 };
    });

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 5, 6);
    const redRim = new THREE.PointLight(0xff3b1f, 14, 10, 1.4);
    redRim.position.set(0, 3.2, -1.5);
    scene.add(key, redRim, new THREE.AmbientLight(0x404050, 0.6));

    const mc = new MarchingCubes(40, chrome, false, false, 40000);
    mc.position.copy(MC_POS);
    mc.scale.setScalar(MC_SCALE);
    mc.isolation = 80;
    scene.add(mc);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      // Fit the scene (about 7.2 wide, 5.8 tall incl. labels) on every panel shape by pulling the camera back.
      const vFit = 5.8 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const hFit = 7.4 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      camera.position.z = Math.max(vFit, hFit);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const clock = new THREE.Clock();
    const p = new THREE.Vector3();
    const project = new THREE.Vector3();
    let raf = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      // Real elapsed time (capped at 0.5s after a stall), so fills keep pace even if frames are slow.
      const dt = Math.min(clock.getDelta(), 0.5);
      const t = clock.elapsedTime;
      const { legs: L, execution: ex, from: F } = live.current;

      mc.reset();
      let pouredShare = 0;

      for (const [i, v] of vaults.entries()) {
        const leg = L.find((l) => l.venue === v.slot.venue);
        const share = leg ? leg.pct / 100 : 0;
        const { status } = vaultStatus(v.slot.venue, ex);
        const targetH = share * MAX_FILL;
        const startH = ((F?.find((l) => l.venue === v.slot.venue)?.pct ?? 0) / 100) * MAX_FILL;
        // Level follows status: flowing moves 35% of the way from start to target, filled/confirmed all the way.
        const goal = status === "filled" ? targetH : status === "flowing" ? startH + (targetH - startH) * 0.35 : startH;
        const draining = targetH < startH - 1e-4;
        v.level += (goal - v.level) * (1 - Math.exp(-dt * 1.8));
        v.column.visible = v.level > 0.01;
        v.column.scale.y = Math.max(0.001, v.level);
        v.column.position.y = VAULT_BOTTOM + 0.02 + v.level / 2;
        (v.target.material as THREE.MeshBasicMaterial).opacity = share > 0 ? 0.55 + 0.25 * Math.sin(t * 3) : 0;
        v.target.position.y = VAULT_BOTTOM + 0.02 + targetH;
        (v.shell.material as THREE.MeshPhysicalMaterial).emissive.setHex(status === "failed" ? 0xff2a1a : 0x000000);
        pouredShare += v.level / MAX_FILL;

        // Liquid surface: a wobbling cap of metaballs on the column.
        if (v.level > 0.01) {
          const topY = VAULT_BOTTOM + 0.02 + v.level;
          for (let k = 0; k < 4; k++) {
            p.set(v.slot.x + Math.sin(t * 2.2 + k * 1.6 + i) * 0.28, topY - 0.02 + Math.sin(t * 3.1 + k) * 0.03, Math.cos(t * 1.7 + k * 1.3) * 0.2);
            const [x, y, z] = toCube(p);
            mc.addBall(x, y, z, 0.07, 30);
          }
        }

        // Stream: droplets travelling from the mass into the vault while it fills (reversed while it drains).
        const pouring = status === "flowing" || (status === "filled" && Math.abs(goal - v.level) > 0.02);
        if (pouring) {
          v.streamT += dt;
          const top = new THREE.Vector3(v.slot.x, VAULT_BOTTOM + VAULT_H + 0.15, 0);
          const ctrl = new THREE.Vector3(v.slot.x * 0.55, BLOB.y + 0.9, 0.2);
          for (let d = 0; d < 7; d++) {
            const u0 = (v.streamT * 0.9 + d / 7) % 1;
            const u = draining ? 1 - u0 : u0;
            const a = 1 - u;
            p.set(
              a * a * BLOB.x + 2 * a * u * ctrl.x + u * u * top.x,
              a * a * (BLOB.y - 0.2) + 2 * a * u * ctrl.y + u * u * top.y,
              a * a * BLOB.z + 2 * a * u * ctrl.z + u * u * top.z,
            );
            const [x, y, z] = toCube(p);
            mc.addBall(x, y, z, 0.18 + 0.1 * Math.sin(u * Math.PI), 44);
          }
        }

        // Label under each vault: projected from 3D so it tracks the camera on every panel size.
        const label = labelRefs.current[i];
        if (label) {
          project.set(v.slot.x, VAULT_BOTTOM - 0.42, 0).project(camera);
          label.style.left = `${(project.x * 0.5 + 0.5) * 100}%`;
          label.style.top = `${(-project.y * 0.5 + 0.5) * 100}%`;
        }
      }

      // The body: a breathing chrome mass that shrinks as capital pours out of it (and grows as it comes back idle).
      const mass = Math.max(0.25, 1 - pouredShare * 0.75);
      for (let k = 0; k < 6; k++) {
        const a = t * 0.8 + k * 1.05;
        p.set(BLOB.x + Math.cos(a) * 0.4 * mass, BLOB.y + Math.sin(a * 1.3) * 0.18 * mass, Math.sin(a) * 0.25 * mass);
        const [x, y, z] = toCube(p);
        mc.addBall(x, y, z, 0.26 * mass + 0.05, 12);
      }
      mc.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className="liquid">
      <div className="liquid-backdrop" aria-hidden />
      <div ref={mountRef} className="liquid-canvas" />
      <div className="liquid-title">
        <div className="hud-title">{from ? "T1000 // REBALANCING" : "T1000 // DEPLOYING CAPITAL"}</div>
        <div className="hud-sub">{execution?.mode === "live" ? (execution.by === "wallet" ? "LIVE · YOUR WALLET" : "LIVE · MAINNET") : "SIMULATION · NOTHING IS SENT"}</div>
      </div>
      {SLOTS.map((slot, i) => {
        const leg = legs.find((l) => l.venue === slot.venue);
        const before = from?.find((l) => l.venue === slot.venue);
        const { note } = vaultStatus(slot.venue, execution);
        const moved = before && leg && Math.abs(before.usd - leg.usd) >= 0.01;
        const amt = from
          ? (moved ? `$${before.usd.toFixed(2)} → $${leg.usd.toFixed(2)}` : `$${(leg?.usd ?? 0).toFixed(2)}`)
          : leg ? `${leg.pct}% · $${leg.usd.toFixed(2)}` : "0%";
        return (
          <div key={slot.venue} ref={(el) => { labelRefs.current[i] = el; }} className="liquid-label" style={{ color: slot.css }}>
            <div className="liquid-name">{VENUES[slot.venue].hud}</div>
            <div className="liquid-amt">{amt}</div>
            <div className="liquid-note">{from ? (moved ? note : "HOLD") : leg ? note : "NOT IN PLAN"}</div>
          </div>
        );
      })}
    </div>
  );
}
