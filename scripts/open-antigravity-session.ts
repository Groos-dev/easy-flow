// Run with pnpm exec tsx scripts/open-antigravity-session.ts <conversation-uuid>.
import { openAntigravityConversation } from '../server/antigravity-navigation.ts'

const result = await openAntigravityConversation(process.argv[2] ?? '')
process.stdout.write(result + '\n')
process.exitCode = result === 'opened' ? 0 : 1
