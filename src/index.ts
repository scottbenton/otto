export function createGreeting(name: string): string {
  const normalizedName = name.trim();

  if (normalizedName.length === 0) {
    throw new Error("Name is required.");
  }

  return `Hello, ${normalizedName}. Otto is ready.`;
}
