/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@lapsed/ui", "@lapsed/fixtures", "@lapsed/shopify", "@lapsed/db", "@lapsed/core"],
};

export default nextConfig;
