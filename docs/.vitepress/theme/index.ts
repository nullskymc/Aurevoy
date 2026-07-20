import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import LandingPage from './LandingPage.vue'
import './custom.css'
import './landing.css'

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('LandingPage', LandingPage)
  },
}

export default theme
