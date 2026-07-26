import { clerkMiddleware } from '@clerk/nextjs/server'

// Make all routes public - authentication is optional
// Exclude upload and video routes to avoid file size limits
export default clerkMiddleware()

export const config = {
  matcher: [
    // Skip Next.js internals, static files, upload API, and video serving
    '/((?!_next|api/upload|api/video|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
}
