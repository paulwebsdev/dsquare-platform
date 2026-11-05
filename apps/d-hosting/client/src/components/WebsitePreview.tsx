import { useState } from "react";

type PreviewMode = "desktop" | "tablet" | "mobile";

interface WebsitePreviewProps {
  previewUrl: string;
}

const VIEWPORTS: Record<PreviewMode, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

export default function WebsitePreview({
  previewUrl,
}: WebsitePreviewProps) {
  const [mode, setMode] = useState<PreviewMode>("desktop");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  const frameUrl = `${previewUrl.replace(/\/+$/, "")}/index.html`;

  return (
    <section className="w-full overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-3 dark:border-gray-700">
        <div>
          <h3 className="font-semibold text-gray-900 dark:text-white">
            Website Preview
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Preview your uploaded website
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(["desktop", "tablet", "mobile"] as PreviewMode[]).map(
            (viewport) => (
              <button
                key={viewport}
                type="button"
                onClick={() => setMode(viewport)}
                className={`rounded-lg px-3 py-2 text-xs font-medium capitalize transition ${
                  mode === viewport
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                }`}
              >
                {viewport}
              </button>
            )
          )}

          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setRefreshKey((current) => current + 1);
            }}
            className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex min-h-[500px] justify-center overflow-auto bg-gray-100 p-3 dark:bg-gray-950">
        <div
          className="relative min-h-[500px] max-w-full overflow-hidden rounded-lg bg-white shadow-sm transition-all"
          style={{
            width: VIEWPORTS[mode],
            flexShrink: 0,
          }}
        >
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              Loading website preview...
            </div>
          )}

          <iframe
            key={refreshKey}
            title="Uploaded website preview"
            src={frameUrl}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
            className="h-[500px] w-full border-0 bg-white"
          />
        </div>
      </div>
    </section>
  );
}
