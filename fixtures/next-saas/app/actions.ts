"use server";

export async function submitForm(data: FormData) {
  const name = data.get("name");
  return { success: true, name };
}
