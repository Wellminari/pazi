; Cria o atalho "Pazi Atende", que abre direto o WhatsApp do Pazi.
; É o mesmo programa do Pazi, aberto com o argumento --atende.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Pazi Atende.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--atende" "$INSTDIR\resources\atende.ico" 0
  CreateShortCut "$DESKTOP\Pazi Atende.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--atende" "$INSTDIR\resources\atende.ico" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Pazi Atende.lnk"
  Delete "$DESKTOP\Pazi Atende.lnk"
!macroend
