/** what a chat attachment looks like in the transcript: a thumbnail for images, a chip for anything else */

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg"];

export const attachmentName = (path: string) => path.split(/[\\/]/).pop() || path;

export function isImageAttachment(path: string) {
  const name = attachmentName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.includes(name.slice(dot));
}
