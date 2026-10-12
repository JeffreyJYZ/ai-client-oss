import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../App.css";
import Docs from "./Docs";
import "./docs.css";

const root = document.getElementById("root");

// biome-ignore lint/plugin/no-throw: root element must exist before mount
if (!root) throw new Error("unable to locate root");

createRoot(root).render(
	<StrictMode>
		<Docs />
	</StrictMode>,
);
