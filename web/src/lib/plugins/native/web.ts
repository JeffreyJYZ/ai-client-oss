import type { NativeHandle } from "@lib/plugins/services";
import { Option } from "effect";

/**
 * The web build's native bridge (spec §7): the browser has no filesystem and no
 * Rust shell, so there is no handle. A plugin checks the `Option` and degrades,
 * rather than calling a method that silently does nothing.
 */
export const webNative: Option.Option<NativeHandle> = Option.none();
