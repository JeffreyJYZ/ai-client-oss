import type { Db } from "@lib/db";
import type { Contribution, HostRegistry } from "@lib/plugins/host";
import { pluginKit } from "@lib/plugins/kit";
import { makeNotifyService } from "@lib/plugins/notify";
import type { Disposable, RegistryEntry } from "@lib/plugins/registry";
import type { RendererKind } from "@lib/plugins/renderers";
import type { Host } from "@lib/plugins/sdk";
import { makeChatService, makeLogger } from "@lib/plugins/services";
import type { SettingsSection } from "@lib/plugins/settings";
import type { ThemeDefinition } from "@lib/plugins/themes";
import type { Tool } from "@lib/plugins/tools";
import { Effect, Option, Stream } from "effect";

/** One registration captured by the recording host. */
export interface RecordingHostRecords {
	readonly ui: Contribution[];
	readonly commands: RegistryEntry[];
	readonly tools: Tool[];
	readonly pipeline: RegistryEntry[];
	readonly renderers: ReadonlyArray<{
		readonly kind: RendererKind;
		readonly component: unknown;
	}>;
	readonly providers: RegistryEntry[];
	readonly presets: RegistryEntry[];
	readonly settingsSections: SettingsSection[];
	readonly themes: ThemeDefinition[];
}

export interface RecordingHost {
	readonly host: Host;
	readonly records: RecordingHostRecords;
}

const noopDisposable: Disposable = { dispose: () => {} };

const emptyStream = <A>(): Stream.Stream<A> =>
	Stream.empty as unknown as Stream.Stream<A>;

/** A recording fake of `Host`: records the eight registries, no-ops the rest. */
export const createRecordingHost = (): RecordingHost => {
	const ui: Contribution[] = [];
	const commands: RegistryEntry[] = [];
	const tools: Tool[] = [];
	const pipeline: RegistryEntry[] = [];
	const renderers: Array<{ kind: RendererKind; component: unknown }> = [];
	const providers: RegistryEntry[] = [];
	const presets: RegistryEntry[] = [];
	const settingsSections: SettingsSection[] = [];
	const themes: ThemeDefinition[] = [];

	const uiRegistry: HostRegistry<Contribution> = {
		register: (entry) => {
			ui.push(entry as Contribution);
			return noopDisposable;
		},
		entries: () => Effect.succeed([] as readonly Contribution[]),
		ownedBy: () => Effect.succeed([] as readonly Contribution[]),
		changes: emptyStream<readonly Contribution[]>(),
	};

	const genericRegistry = <E extends RegistryEntry>(
		bucket: E[],
	): HostRegistry<E> => ({
		register: (entry) => {
			bucket.push(entry as E);
			return noopDisposable;
		},
		entries: () => Effect.succeed([] as readonly E[]),
		ownedBy: () => Effect.succeed([] as readonly E[]),
		changes: emptyStream<readonly E[]>(),
	});

	const commandsRegistry = genericRegistry<RegistryEntry>(commands);
	const providersRegistry = genericRegistry<RegistryEntry>(providers);
	const presetsRegistry = genericRegistry<RegistryEntry>(presets);
	const pipelineRegistry = genericRegistry<RegistryEntry>(pipeline);

	const toolsRegistry = {
		register: (tool: Tool, _pluginId?: string) => {
			tools.push(tool);
			return noopDisposable;
		},
		entries: () => Effect.succeed([] as readonly never[]),
		ownedBy: () => Effect.succeed([] as readonly never[]),
		changes: emptyStream<readonly never[]>(),
	};

	const settingsRegistry = {
		registerSection: (section: SettingsSection) => {
			settingsSections.push(section);
			return noopDisposable;
		},
	};

	const renderersRegistry = {
		register: (kind: RendererKind, component: unknown) => {
			renderers.push({ kind, component });
			return noopDisposable;
		},
	};

	const themeService = {
		register: (theme: ThemeDefinition) => {
			themes.push(theme);
			return noopDisposable;
		},
		apply: (_id: string) => Effect.void,
		clear: () => Effect.void,
		active: () => Effect.succeed(Option.none<string>()),
		sync: (_entries: readonly RegistryEntry[]) => Effect.void,
		run: () => Effect.void,
	};

	const host: Host = {
		version: { app: "0.0.0", api: "0.1" },
		ui: { ...uiRegistry, kit: pluginKit },
		commands: commandsRegistry,
		settings: settingsRegistry,
		tools: toolsRegistry as unknown as Host["tools"],
		providers: providersRegistry,
		presets: presetsRegistry as unknown as Host["presets"],
		pipeline: pipelineRegistry,
		renderers: renderersRegistry as unknown as Host["renderers"],
		themes: themeService as unknown as Host["themes"],
		chat: makeChatService(),
		db: {} as Db,
		storage: {
			get: (_key: string) => Effect.succeed(Option.none<unknown>()),
			set: (_key: string, _value: unknown) => Effect.void,
			delete: (_key: string) => Effect.void,
			keys: () => Effect.succeed([] as readonly string[]),
		},
		notify: makeNotifyService(),
		native: Option.none(),
		log: makeLogger(),
		on: (_event, _handler) => noopDisposable,
		run: (_effect) => {},
	};

	const records: RecordingHostRecords = {
		get ui() {
			return ui;
		},
		get commands() {
			return commands;
		},
		get tools() {
			return tools;
		},
		get pipeline() {
			return pipeline;
		},
		get renderers() {
			return renderers;
		},
		get providers() {
			return providers;
		},
		get presets() {
			return presets;
		},
		get settingsSections() {
			return settingsSections;
		},
		get themes() {
			return themes;
		},
	};

	return { host, records };
};
