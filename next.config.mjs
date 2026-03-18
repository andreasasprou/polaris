/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/**": ["./lib/sandbox-proxy/dist/**"],
  },
}

export default nextConfig
