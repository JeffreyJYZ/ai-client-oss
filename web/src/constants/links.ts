/** The project's public site — the web build, and the app's public identity. */
export const SITE_URL = "https://aiclient.jyz.land";

/**
 * The published documentation: the plugin author guide, the registry reference
 * and the capabilities table. Its own Vite entry (`/docs/`), so a link is the
 * only way in — the app itself renders none of it.
 */
export const DOCS_URL = `${SITE_URL}/docs/`;

/** GitHub repository that publishes the desktop builds. */
export const GITHUB_REPOSITORY = "JeffreyJYZ/ai-client-oss";
/** All releases. */
export const RELEASES_URL = `https://github.com/${GITHUB_REPOSITORY}/releases`;
/** Newest release — the download target. */
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
