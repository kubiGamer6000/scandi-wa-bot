import { config } from '../../config.js'

const DEFAULT_VIDEO_PROMPT = `Analyze this video and provide:
1. A concise summary of the overall content (1-2 sentences).
2. A timestamped visual description of what happens on screen, broken into segments/scenes.
3. A full transcript of any spoken audio, with timestamps where possible.
4. Any on-screen text, captions, or overlays.

Format the output as clean markdown with clear section headings.`

const DEFAULT_IMAGE_PROMPT = `Describe this image in detail:
1. What is shown in the image (subjects, objects, setting, composition).
2. Any text visible in the image (OCR).
3. The mood, style, or context if apparent.
4. If it's a screenshot, describe the UI/content shown.
5. If it's a sticker or meme, describe the visual and any text/meaning.

Be concise but thorough. Format as clean markdown.`

export const getVideoPrompt = (): string =>
	config.processing.promptVideo ?? DEFAULT_VIDEO_PROMPT

export const getImagePrompt = (): string =>
	config.processing.promptImage ?? DEFAULT_IMAGE_PROMPT
