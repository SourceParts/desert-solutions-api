/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for deployment
  output: "standalone",

  // Transpile shared workspace package
  transpilePackages: ["@sourceparts/shared"],

  // Logging configuration
  logging: {
    fetches: {
      fullUrl: true,
    },
  },
};

export default nextConfig;
