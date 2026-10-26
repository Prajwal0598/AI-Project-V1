// The single Graph API version every outbound Meta call from the API uses. Meta keeps a version usable for two years after
// its successor ships and then silently serves calls on the next usable version, so check the changelog before bumping:
// https://developers.facebook.com/docs/graph-api/changelog. apps/worker and apps/web carry a copy of this constant;
// meta-graph-version.spec.ts fails if the three ever differ or a version literal appears anywhere else.
export const META_GRAPH_API_VERSION = "v26.0";
export const META_GRAPH_BASE_URL = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
